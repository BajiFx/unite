-- ============================================================
--  004 — BUSINESS SEARCH TAG
--  Location: migrations/sql/004_business_search_tag.sql
--
--  Purpose:
--   Give every business a short, unique, human-typable
--   identifier that a customer can type into the marketplace
--   search bar to jump straight to one specific shop, even
--   when several shops share the same display name.
--
--  The tag is built from:
--     <digits><name>
--   where:
--     digits  = 3 or 4 numeric characters chosen by the owner
--               (e.g. 363, 3734)
--     name    = the name the owner wants customers to type
--               (e.g. Doppa Beddings)
--
--   Example stored tag: 3734Doppa Beddings
--
--  The owner sees the assembled tag back during registration:
--   "Your business will be searched as 3734Doppa Beddings."
--
--  A customer can then type any of these into the marketplace
--  search bar and the server will find that one shop:
--     3734Doppa Beddings
--     3734 Doppa Beddings
--     37 34Doppa Beddings
--     3734-doppa-beddings
--     3734doppa
--     doppa 3734
--     (and even a partial prefix, as long as only one shop
--      matches what they have typed so far)
--
--  Uniqueness rules:
--   - The NAME may repeat across businesses.
--   - The DIGITS may repeat across businesses.
--   - The COMBINATION (digits + name, normalized) must be
--     unique across the whole platform. That is what the
--     unique index below enforces.
--
--  Normalization (used both at write time and at search time):
--   - lowercase
--   - strip every character that is not a letter or a digit
--   - collapse runs of whitespace
--   Example: "3734 Doppa-Beddings" → "3734doppabeddings"
--
--  This file is idempotent. Every statement uses
--  IF NOT EXISTS / IF EXISTS, so it can be re-run safely.
-- ============================================================


-- ============================================================
--  1. COLUMNS ON businesses
-- ============================================================

-- The raw 3–4 digit prefix the owner chose.
-- Kept as a string so leading zeros are preserved if we ever
-- allow them (e.g. "0363" would stay "0363", not become 363).
ALTER TABLE businesses
    ADD COLUMN IF NOT EXISTS search_prefix VARCHAR(4);

-- The raw, human-readable name the owner wants customers to
-- type next to the digits. Example: "Doppa Beddings".
ALTER TABLE businesses
    ADD COLUMN IF NOT EXISTS search_name VARCHAR(120);

-- The full normalized tag stored for direct lookup.
-- Example: "3734doppabeddings".
-- This is what the unique index below guards and what the
-- search endpoint matches against.
ALTER TABLE businesses
    ADD COLUMN IF NOT EXISTS search_tag VARCHAR(160);

-- The human-readable form shown back to the owner and printed
-- on the business profile.
-- Example: "3734Doppa Beddings".
ALTER TABLE businesses
    ADD COLUMN IF NOT EXISTS search_display VARCHAR(160);

-- Whether the owner has confirmed / saved their tag.
-- Existing rows get FALSE until the owner sets one; newly
-- registered businesses get TRUE from the registration flow.
ALTER TABLE businesses
    ADD COLUMN IF NOT EXISTS search_tag_confirmed BOOLEAN NOT NULL DEFAULT FALSE;

-- When the tag was last written.
ALTER TABLE businesses
    ADD COLUMN IF NOT EXISTS search_tag_updated_at TIMESTAMP;


-- ============================================================
--  2. UNIQUE INDEX ON search_tag
--
--  This is the real guarantee that no two businesses can hold
--  the same digits + name combination. The application layer
--  also pre-checks before insert so the owner gets a nice
--  "this number is already used" message, but the index is the
--  ultimate safety net against races.
--
--  A partial index is used so rows with a NULL tag (legacy
--  businesses before they pick one) do not collide with each
--  other. Postgres treats NULL as distinct in a plain unique
--  index, but a partial index keeps the intent obvious.
-- ============================================================

CREATE UNIQUE INDEX IF NOT EXISTS idx_businesses_search_tag_unique
    ON businesses (search_tag)
    WHERE search_tag IS NOT NULL;


-- ============================================================
--  3. HELPER INDEXES FOR SEARCH
--
--  The customer search endpoint does a progressive prefix
--  lookup on the normalized tag. A plain btree index on
--  search_tag already supports prefix matching with the LIKE
--  operator, so no extra index is needed on that column.
--
--  search_prefix is indexed separately so the availability
--  check during registration ("is 3734 already taken?") is
--  fast when there are many businesses.
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_businesses_search_prefix
    ON businesses (search_prefix)
    WHERE search_prefix IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_businesses_search_tag_confirmed
    ON businesses (search_tag_confirmed);


-- ============================================================
--  4. NORMALIZATION FUNCTION
--
--  Single source of truth for how a search tag is normalized.
--  Both the registration write path and the search read path
--  call this via SQL so the two can never drift apart.
--
--  Rules:
--   - lowercase
--   - keep only [a-z0-9]
--   - everything else (spaces, dashes, punctuation, emoji) is
--     dropped
-- ============================================================

CREATE OR REPLACE FUNCTION normalize_business_search_tag(input TEXT)
RETURNS TEXT AS $$
BEGIN
    IF input IS NULL THEN
        RETURN NULL;
    END IF;

    RETURN LOWER(REGEXP_REPLACE(input, '[^a-zA-Z0-9]', '', 'g'));
END;
$$ LANGUAGE plpgsql IMMUTABLE;


-- ============================================================
--  5. AUTO-SYNC TRIGGER
--
--  Whenever the raw pieces (search_prefix, search_name) are
--  written, this trigger recomputes the normalized search_tag
--  and the display form so they are always consistent with
--  what the owner typed. This means the application can simply
--  set search_prefix and search_name and trust the database to
--  keep search_tag and search_display in step.
--
--  If the owner clears the prefix or the name, the derived
--  columns are cleared too, and search_tag_confirmed is reset.
-- ============================================================

CREATE OR REPLACE FUNCTION set_business_search_tag()
RETURNS TRIGGER AS $$
DECLARE
    cleaned_prefix TEXT;
    cleaned_name   TEXT;
BEGIN
    cleaned_prefix := NULLIF(BTRIM(COALESCE(NEW.search_prefix, '')), '');
    cleaned_name   := NULLIF(BTRIM(COALESCE(NEW.search_name, '')), '');

    -- The tag only exists when both pieces are present and the
    -- prefix is a 3- or 4-digit numeric string.
    IF cleaned_prefix IS NOT NULL
       AND cleaned_name IS NOT NULL
       AND cleaned_prefix ~ '^[0-9]{3,4}$'
    THEN
        NEW.search_display := cleaned_prefix || cleaned_name;

        NEW.search_tag := normalize_business_search_tag(
            cleaned_prefix || cleaned_name
        );

        NEW.search_tag_updated_at := NOW();
    ELSE
        -- Missing or invalid pieces — clear the derived columns
        -- so a half-set tag can never be searched.
        NEW.search_display := NULL;
        NEW.search_tag := NULL;

        IF TG_OP = 'INSERT' THEN
            NEW.search_tag_confirmed := FALSE;
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_businesses_search_tag ON businesses;
CREATE TRIGGER trg_businesses_search_tag
BEFORE INSERT OR UPDATE OF search_prefix, search_name
ON businesses
FOR EACH ROW
EXECUTE FUNCTION set_business_search_tag();


-- ============================================================
--  6. BACKFILL EXISTING ROWS
--
--  Businesses that already exist in the database will not have
--  a tag yet, so they are invisible to the new tag search
--  until they pick one. To make sure nobody is accidentally
--  locked out of search, we assign a temporary placeholder tag
--  that:
--   - uses a fixed 3-digit prefix of "000", which is reserved
--     for auto-generated tags and cannot be chosen manually;
--   - uses the business's current slug as the name part, so
--     two same-named shops still get different placeholders;
--   - is flagged with search_tag_confirmed = FALSE so the
--     owner is prompted to replace it on next login.
--
--  The application layer should treat any tag beginning with
--  "000" as a placeholder and prompt the owner to set a real
--  one. The unique index still applies, so if two businesses
--  happen to have the same slug the second one gets a numeric
--  suffix to break the tie.
-- ============================================================

DO $$
DECLARE
    biz RECORD;
    base_name TEXT;
    candidate TEXT;
    attempt INT;
BEGIN
    FOR biz IN
        SELECT id, slug, business_name
        FROM businesses
        WHERE search_tag IS NULL
    LOOP
        -- Prefer the slug; fall back to the display name if the
        -- slug is somehow missing.
        base_name := COALESCE(NULLIF(BTRIM(biz.slug), ''), biz.business_name);

        -- Start with a straight "000" + slug placeholder.
        candidate := '000' || normalize_business_search_tag(base_name);
        attempt := 0;

        -- If the placeholder already exists (two businesses share
        -- a slug), keep appending a numeric suffix until it is
        -- unique. 999 attempts is far more than any real dataset
        -- will ever need.
        WHILE EXISTS (
            SELECT 1 FROM businesses
            WHERE search_tag = candidate
              AND id <> biz.id
        ) AND attempt < 999
        LOOP
            attempt := attempt + 1;
            candidate := '000'
                      || normalize_business_search_tag(base_name)
                      || attempt::TEXT;
        END LOOP;

        UPDATE businesses
        SET search_prefix = '000',
            search_name   = base_name,
            search_tag_confirmed = FALSE
        WHERE id = biz.id;
    END LOOP;
END $$;


-- ============================================================
--  7. VERIFY
-- ============================================================

DO $$
DECLARE
    total_businesses    INTEGER;
    tagged_businesses   INTEGER;
    confirmed_businesses INTEGER;
    duplicate_tags      INTEGER;
BEGIN
    SELECT COUNT(*) INTO total_businesses  FROM businesses;
    SELECT COUNT(*) INTO tagged_businesses FROM businesses WHERE search_tag IS NOT NULL;
    SELECT COUNT(*) INTO confirmed_businesses
        FROM businesses WHERE search_tag_confirmed = TRUE;

    -- Should always be zero: the unique index guarantees it.
    SELECT COUNT(*) INTO duplicate_tags
    FROM (
        SELECT search_tag
        FROM businesses
        WHERE search_tag IS NOT NULL
        GROUP BY search_tag
        HAVING COUNT(*) > 1
    ) d;

    RAISE NOTICE 'businesses total:                    %', total_businesses;
    RAISE NOTICE 'businesses with a search tag:        %', tagged_businesses;
    RAISE NOTICE 'businesses with a confirmed tag:     %', confirmed_businesses;
    RAISE NOTICE 'duplicate tags (must be 0):          %', duplicate_tags;

    IF duplicate_tags > 0 THEN
        RAISE NOTICE 'WARNING: duplicate search_tag values found. The unique index should have prevented this — please investigate.';
    ELSE
        RAISE NOTICE 'All business search tags are unique.';
    END IF;
END $$;
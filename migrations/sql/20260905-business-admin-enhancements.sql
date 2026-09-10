-- Business-admin fields that were not part of the initial marketplace schema.
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS linkedin VARCHAR(255);
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS phone_numbers JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS email_addresses JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS custom_category VARCHAR(255);

ALTER TABLE products ADD COLUMN IF NOT EXISTS images JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE products ADD COLUMN IF NOT EXISTS videos JSONB NOT NULL DEFAULT '[]'::jsonb;

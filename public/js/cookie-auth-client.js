(() => {
    const nativeFetch = window.fetch.bind(window);
    let csrfTokenPromise;

    async function getCsrfToken() {
        if (!csrfTokenPromise) {
            csrfTokenPromise = nativeFetch('/api/csrf-token', { credentials: 'same-origin' })
                .then(response => response.json())
                .then(data => data.csrfToken);
        }
        return csrfTokenPromise;
    }

    window.fetch = async (input, init = {}) => {
        const requestUrl = typeof input === 'string' ? input : input.url;
        const url = new URL(requestUrl, window.location.origin);
        const method = (init.method || (typeof input !== 'string' ? input.method : 'GET')).toUpperCase();
        const isApiMutation = url.origin === window.location.origin && url.pathname.startsWith('/api/') &&
            !['GET', 'HEAD', 'OPTIONS'].includes(method);
        const requestInit = { ...init, credentials: init.credentials || 'same-origin' };

        if (!isApiMutation) return nativeFetch(input, requestInit);

        const headers = new Headers(requestInit.headers || (typeof input !== 'string' ? input.headers : undefined));
        headers.set('X-CSRF-Token', await getCsrfToken());
        return nativeFetch(input, { ...requestInit, headers });
    };
})();

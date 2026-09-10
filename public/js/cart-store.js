// Shared client-side cart store.  Several pages use these helpers, so keep
// them independent from any one page's UI script.
(function () {
    function getCart() {
        try {
            const cart = JSON.parse(localStorage.getItem('cart') || '[]');
            return Array.isArray(cart) ? cart : [];
        } catch (error) {
            console.warn('Invalid saved cart; starting with an empty cart.', error);
            return [];
        }
    }

    function saveCart(cart) {
        localStorage.setItem('cart', JSON.stringify(Array.isArray(cart) ? cart : []));
        window.dispatchEvent(new CustomEvent('cart:changed'));
    }

    function clearCart() {
        localStorage.removeItem('cart');
        window.dispatchEvent(new CustomEvent('cart:changed'));
    }

    async function addToCart(productId, quantity = 1) {
        const id = Number(productId);
        if (!Number.isFinite(id)) return;

        try {
            const response = await fetch(`/api/products/${id}/detail`);
            if (!response.ok) throw new Error('Product is unavailable');
            const payload = await response.json();
            const product = payload.product || payload;
            const cart = getCart();
            const existing = cart.find(item => Number(item.id) === id && !item.variant_id);

            if (existing) {
                existing.quantity += Math.max(1, Number(quantity) || 1);
            } else {
                cart.push({
                    id,
                    name: product.name || 'Product',
                    price: Number(product.price) || 0,
                    image: product.image || '',
                    quantity: Math.max(1, Number(quantity) || 1),
                    business_id: product.business_id || null
                });
            }
            saveCart(cart);
            if (typeof window.updateCartBadge === 'function') window.updateCartBadge();
            if (typeof window.showToast === 'function') window.showToast('Added to cart.', 'success');
        } catch (error) {
            console.error('Add to cart failed:', error);
            if (typeof window.showToast === 'function') window.showToast('Unable to add this product to cart.', 'error');
        }
    }

    window.getCart = getCart;
    window.saveCart = saveCart;
    window.clearCart = clearCart;
    window.addToCart = addToCart;
})();

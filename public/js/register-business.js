// ============================================================
//  REGISTER BUSINESS JAVASCRIPT - COMPLETE VERSION
//  Location: public/js/register-business.js
// ============================================================

// ============================================================
//  GLOBALS
// ============================================================

let currentStep = 1;
const totalSteps = 4;

// ============================================================
//  INIT
// ============================================================

document.addEventListener('DOMContentLoaded', function() {
    console.log('📄 Register Business page loaded');

    // Setup payment toggles
    setupPaymentToggles();

    // Password strength checker
    const passwordInput = document.getElementById('businessPassword');
    if (passwordInput) {
        passwordInput.addEventListener('input', function() {
            showPasswordStrength(this.value);
        });
    }
});

// ============================================================
//  PASSWORD STRENGTH
// ============================================================

function showPasswordStrength(password) {
    const container = document.getElementById('passwordStrength');
    if (!container) return;

    if (!password) {
        container.innerHTML = '';
        return;
    }

    let score = 0;
    let feedback = [];

    if (password.length >= 8) score++;
    else feedback.push('At least 8 characters');

    if (/[A-Z]/.test(password)) score++;
    else feedback.push('At least one uppercase letter');

    if (/[a-z]/.test(password)) score++;
    else feedback.push('At least one lowercase letter');

    if (/[0-9]/.test(password)) score++;
    else feedback.push('At least one number');

    if (/[!@#$%^&*(),.?":{}|<>]/.test(password)) score++;

    let strength = 'weak';
    let color = '#ef4444';
    let percentage = 20;

    if (score >= 5) {
        strength = 'strong';
        color = '#22c55e';
        percentage = 100;
    } else if (score >= 4) {
        strength = 'good';
        color = '#f59e0b';
        percentage = 75;
    } else if (score >= 3) {
        strength = 'fair';
        color = '#f97316';
        percentage = 50;
    } else if (score >= 2) {
        strength = 'weak';
        color = '#ef4444';
        percentage = 25;
    }

    const isValid = score >= 3 && password.length >= 8;

    container.innerHTML = `
        <div style="margin-top:4px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:2px;">
                <span style="font-size:0.65rem; color:#64748b;">Password strength:</span>
                <span style="font-size:0.65rem; font-weight:700; color:${color};">${strength.toUpperCase()}</span>
            </div>
            <div style="width:100%; height:4px; background:#e2e8f0; border-radius:4px; overflow:hidden;">
                <div style="width:${percentage}%; height:100%; background:${color}; border-radius:4px; transition: width 0.3s ease;"></div>
            </div>
            ${!isValid && password.length > 0 ? `
                <div style="margin-top:4px; font-size:0.55rem; color:#ef4444;">
                    ${feedback.map(f => `• ${f}`).join('<br>')}
                </div>
            ` : ''}
            ${isValid ? `
                <div style="margin-top:4px; font-size:0.55rem; color:#22c55e;">
                    ✅ Password meets requirements
                </div>
            ` : ''}
        </div>
    `;
}

// ============================================================
//  PAYMENT TOGGLES
// ============================================================

function setupPaymentToggles() {
    const toggles = [
        { id: 'mpesaEnabled', details: 'mpesaDetails' },
        { id: 'airtelEnabled', details: 'airtelDetails' },
        { id: 'bankEnabled', details: 'bankDetails' },
        { id: 'paypalEnabled', details: 'paypalDetails' }
    ];

    toggles.forEach(({ id, details }) => {
        const checkbox = document.getElementById(id);
        const detailsEl = document.getElementById(details);

        if (checkbox && detailsEl) {
            checkbox.addEventListener('change', function() {
                detailsEl.style.display = this.checked ? 'block' : 'none';
            });
        }
    });
}

// ============================================================
//  STEP NAVIGATION
// ============================================================

function goToStep(step) {
    if (step > currentStep) {
        if (!validateStep(currentStep)) {
            return;
        }
    }

    currentStep = step;
    updateSteps();
}

function updateSteps() {
    // Update step indicators
    document.querySelectorAll('.step').forEach((el, index) => {
        const stepNum = index + 1;
        el.classList.remove('active', 'completed');
        if (stepNum === currentStep) {
            el.classList.add('active');
        } else if (stepNum < currentStep) {
            el.classList.add('completed');
        }
    });

    // Update step content
    document.querySelectorAll('.step-content').forEach((el, index) => {
        el.classList.toggle('active', index + 1 === currentStep);
    });

    // Scroll to top of form
    document.querySelector('.register-container')?.scrollIntoView({ behavior: 'smooth' });
}

// ============================================================
//  VALIDATE STEP
// ============================================================

function validateStep(step) {
    if (step === 1) {
        const name = document.getElementById('businessName').value.trim();
        const email = document.getElementById('businessEmail').value.trim();
        const phone = document.getElementById('businessPhone').value.trim();
        const location = document.getElementById('businessLocation').value.trim();
        const password = document.getElementById('businessPassword').value;
        const confirm = document.getElementById('businessConfirm').value;

        if (!name) {
            alert('Please enter your business name');
            document.getElementById('businessName').focus();
            return false;
        }
        if (name.length < 2) {
            alert('Business name must be at least 2 characters');
            return false;
        }
        if (!email) {
            alert('Please enter your business email');
            document.getElementById('businessEmail').focus();
            return false;
        }
        if (!email.includes('@')) {
            alert('Please enter a valid email address');
            return false;
        }
        if (!phone) {
            alert('Please enter your business phone number');
            document.getElementById('businessPhone').focus();
            return false;
        }
        if (phone.replace(/[^0-9]/g, '').length < 10) {
            alert('Please enter a valid phone number (10+ digits)');
            return false;
        }
        if (!location) {
            alert('Please enter your business location');
            document.getElementById('businessLocation').focus();
            return false;
        }
        if (!password || password.length < 8) {
            alert('Password must be at least 8 characters');
            document.getElementById('businessPassword').focus();
            return false;
        }
        if (password !== confirm) {
            alert('Passwords do not match');
            document.getElementById('businessConfirm').focus();
            return false;
        }
        return true;
    }

    return true;
}

// ============================================================
//  SUBMIT BUSINESS REGISTRATION
// ============================================================

document.getElementById('registerForm')?.addEventListener('submit', async function(e) {
    e.preventDefault();

    console.log('📤 Starting business registration submission...');

    // Validate step 3
    if (!validateStep(3)) {
        goToStep(3);
        return;
    }

    // Get form values
    const businessName = document.getElementById('businessName').value.trim();
    const email = document.getElementById('businessEmail').value.trim();
    const phone = document.getElementById('businessPhone').value.trim();
    const location = document.getElementById('businessLocation').value.trim();
    const address = document.getElementById('businessAddress').value.trim();
    const description = document.getElementById('businessDescription').value.trim();
    const mission = document.getElementById('businessMission').value.trim();
    const vision = document.getElementById('businessVision').value.trim();
    const password = document.getElementById('businessPassword').value;
    const confirm = document.getElementById('businessConfirm').value;

    // Validate password
    if (!password || password.length < 8) {
        alert('Password must be at least 8 characters');
        goToStep(3);
        return;
    }
    if (password !== confirm) {
        alert('Passwords do not match');
        goToStep(3);
        return;
    }

    // Create FormData
    const formData = new FormData();

    formData.append('business_name', businessName);
    formData.append('email', email);
    formData.append('phone', phone);
    formData.append('location', location);
    formData.append('address', address || '');
    formData.append('description', description || '');
    formData.append('mission', mission || '');
    formData.append('vision', vision || '');
    formData.append('password', password);

    // Payment Settings
    formData.append('mpesa_enabled', document.getElementById('mpesaEnabled').checked ? 'true' : 'false');
    formData.append('mpesa_number', document.getElementById('mpesaNumber').value.trim());
    formData.append('airtel_enabled', document.getElementById('airtelEnabled').checked ? 'true' : 'false');
    formData.append('airtel_number', document.getElementById('airtelNumber').value.trim());
    formData.append('bank_enabled', document.getElementById('bankEnabled').checked ? 'true' : 'false');
    formData.append('bank_name', document.getElementById('bankName').value.trim());
    formData.append('bank_account', document.getElementById('bankAccount').value.trim());
    formData.append('bank_account_name', document.getElementById('bankAccountName').value.trim());
    formData.append('paypal_enabled', document.getElementById('paypalEnabled').checked ? 'true' : 'false');
    formData.append('paypal_email', document.getElementById('paypalEmail').value.trim());

    // Logo and Hero
    const logoFile = document.getElementById('businessLogo').files[0];
    const heroFile = document.getElementById('businessHero').files[0];
    if (logoFile) formData.append('logo', logoFile);
    if (heroFile) formData.append('heroImage', heroFile);

    // Submit
    const submitBtn = document.querySelector('.btn-success');
    const originalText = submitBtn.innerHTML;
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Registering...';

    try {
        const res = await fetch('/api/auth/business/register', {
            method: 'POST',
            body: formData
        });

        const data = await res.json();
        console.log('📥 Response:', data);

        if (data.success) {
            goToStep(4);

            window.customerToken = 'cookie-auth';

            // Store business info
            if (data.business) {
                localStorage.setItem('businessId', data.business.id);
                localStorage.setItem('businessSlug', data.business.slug);
                localStorage.setItem('businessName', data.business.business_name);
            }

            submitBtn.innerHTML = '✅ Registered!';

            // Redirect to business admin after 3 seconds
            setTimeout(() => {
                window.location.href = '/business-admin.html';
            }, 3000);

        } else {
            const errorMsg = data.error || data.message || 'Registration failed. Please try again.';
            alert('❌ ' + errorMsg);
            submitBtn.disabled = false;
            submitBtn.innerHTML = originalText;
        }
    } catch (err) {
        console.error('❌ Registration error:', err);
        alert('❌ Network error: ' + err.message);
        submitBtn.disabled = false;
        submitBtn.innerHTML = originalText;
    }
});

// ============================================================
//  EXPOSE FUNCTIONS
// ============================================================

window.goToStep = goToStep;
window.validateStep = validateStep;
window.showPasswordStrength = showPasswordStrength;

console.log('✅ Register Business JS loaded successfully');
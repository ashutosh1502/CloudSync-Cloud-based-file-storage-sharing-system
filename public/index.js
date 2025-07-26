// Firebase configuration
const firebaseConfig = {
    apiKey: "your-key",
    authDomain: "domain",
    projectId: "id",
    storageBucket: "s3-bucket",
    messagingSenderId: "sender-id",
    appId: "api-id"
};

// Initialize Firebase
try {
    firebase.initializeApp(firebaseConfig);
    console.log('Firebase initialized successfully');
} catch (error) {
    console.error('Error initializing Firebase:', error);
}

// Get Auth instance
const auth = firebase.auth();

// Helper function to show error message
function showError(elementId, message) {
    const errorElement = document.getElementById(elementId);
    errorElement.textContent = message;
    errorElement.style.display = 'block';
}

// Helper function to hide error message
function hideError(elementId) {
    const errorElement = document.getElementById(elementId);
    errorElement.style.display = 'none';
}

// Helper function to set loading state
function setLoading(button, isLoading) {
    if (isLoading) {
        button.classList.add('loading');
        button.disabled = true;
    } else {
        button.classList.remove('loading');
        button.disabled = false;
    }
}

// Helper function to get error message
function getErrorMessage(error) {
    console.log('Error code:', error.code); // For debugging

    switch (error.code) {
        // Sign in errors
        case 'auth/invalid-credential':
        case 'auth/wrong-password':
        case 'auth/user-not-found':
            return 'Invalid email or password. Please try again.';

        case 'auth/invalid-email':
            return 'Please enter a valid email address.';

        case 'auth/user-disabled':
            return 'This account has been disabled. Please contact support.';

        case 'auth/too-many-requests':
            return 'Too many failed attempts. Please try again later.';

        // Sign up errors
        case 'auth/email-already-in-use':
            return 'This email is already registered. Please sign in instead.';

        case 'auth/weak-password':
            return 'Password is too weak. Please use at least 6 characters.';

        case 'auth/operation-not-allowed':
            return 'Email/password sign up is not enabled. Please contact support.';

        case 'auth/network-request-failed':
            return 'Network error. Please check your internet connection.';

        case 'auth/popup-closed-by-user':
            return 'Sign in window was closed. Please try again.';

        case 'auth/cancelled-popup-request':
            return 'The sign in process was cancelled. Please try again.';

        case 'auth/timeout':
            return 'The request timed out. Please try again.';

        case 'auth/quota-exceeded':
            return 'Service temporarily unavailable. Please try again later.';

        case 'auth/requires-recent-login':
            return 'Please sign in again to continue.';

        case 'auth/invalid-password':
            return 'Invalid password. Please try again.';

        case 'auth/missing-password':
            return 'Please enter your password.';

        default:
            // Log unexpected errors for debugging
            console.error('Unexpected error code:', error.code);
            return 'An error occurred. Please try again.';
    }
}

// Handle tab switching
const tabs = document.querySelectorAll('.tab');
const forms = document.querySelectorAll('.form');

tabs.forEach(tab => {
    tab.addEventListener('click', function () {
        // Update active tab
        tabs.forEach(t => t.classList.remove('active'));
        this.classList.add('active');

        // Show corresponding form
        const formToShow = this.getAttribute('data-form');
        forms.forEach(form => {
            form.classList.remove('active');
            if (form.id === `${formToShow}Form`) {
                form.classList.add('active');
            }
        });
    });
});

// Handle Sign Up
document.getElementById('signupForm').addEventListener('submit', async (e) => {
    e.preventDefault();

    const form = e.target;
    const submitButton = form.querySelector('button[type="submit"]');

    // Hide any previous errors
    hideError('signupError');

    const name = document.getElementById('signupName').value.trim();
    const email = document.getElementById('signupEmail').value.trim();
    const password = document.getElementById('signupPassword').value;
    const confirmPassword = document.getElementById('confirmPassword').value;

    // Basic validation
    if (!name) {
        showError('signupError', 'Please enter your name.');
        return;
    }

    if (password !== confirmPassword) {
        showError('signupError', 'Passwords do not match!');
        return;
    }

    if (password.length < 6) {
        showError('signupError', 'Password should be at least 6 characters long.');
        return;
    }

    try {
        setLoading(submitButton, true);
        console.log('Attempting to create user:', email);

        const userCredential = await auth.createUserWithEmailAndPassword(email, password);
        console.log('User created successfully:', userCredential.user.uid);

        // Add the user's name to their profile
        await userCredential.user.updateProfile({
            displayName: name
        });
        console.log('Profile updated successfully');

        // Sign out the user after signup
        await auth.signOut();

        // Show success message
        alert('Account created successfully! Please sign in.');

        // Switch to sign in tab and clear form
        document.querySelector('[data-form="signin"]').click();
        form.reset();

    } catch (error) {
        console.error('Signup error:', error);
        showError('signupError', getErrorMessage(error));
    } finally {
        setLoading(submitButton, false);
    }
});

// Handle Sign In
document.getElementById('signinForm').addEventListener('submit', async (e) => {
    e.preventDefault();

    const form = e.target;
    const submitButton = form.querySelector('button[type="submit"]');

    // Hide any previous errors
    hideError('signinError');

    const email = document.getElementById('signinEmail').value.trim();
    const password = document.getElementById('signinPassword').value;

    try {
        setLoading(submitButton, true);
        console.log('Attempting to sign in:', email);

        await auth.signInWithEmailAndPassword(email, password);
        console.log('Sign in successful');

        // Redirect to home page after successful login
        window.location.href = 'home.html';
    } catch (error) {
        console.error('Sign in error:', error);
        showError('signinError', getErrorMessage(error));
        setLoading(submitButton, false);
    }
});

// Listen for auth state changes
auth.onAuthStateChanged((user) => {
    if (user) {
        console.log('User is signed in:', user.uid);
        // Store user data
        localStorage.setItem('user', JSON.stringify({
            uid: user.uid,
            email: user.email,
            displayName: user.displayName,
            lastLogin: new Date().toISOString()
        }));

        // User is signed in
        if (window.location.pathname.includes('index.html')) {
            window.location.href = 'home.html';
        }
    } else {
        console.log('User is signed out');
        // Clear user data
        localStorage.removeItem('user');

        // User is signed out
        if (!window.location.pathname.includes('index.html')) {
            window.location.href = 'index.html';
        }
    }
});

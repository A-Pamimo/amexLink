// Defaults for every test file. Per-test overrides go through loadApp(env).
process.env.PLAID_CLIENT_ID = "test";
process.env.PLAID_SECRET = "test";
process.env.PLAID_ENV = "sandbox";
process.env.AUTH_MODE = "none";
// Fixed 32-byte test key (base64 of "amexlens-test-key-0123456789abcd"). Not a real key.
process.env.TOKEN_ENCRYPTION_KEY = "YW1leGxlbnMtdGVzdC1rZXktMDEyMzQ1Njc4OWFiY2Q=";

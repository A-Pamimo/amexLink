// Defaults for every test file. Per-test overrides go through loadApp(env).
process.env.PLAID_CLIENT_ID = "test";
process.env.PLAID_SECRET = "test";
process.env.PLAID_ENV = "sandbox";
process.env.AUTH_MODE = "none";

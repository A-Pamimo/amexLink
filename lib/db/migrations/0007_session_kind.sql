-- Mobile app sign-in: a session is either a browser cookie session or a native-app bearer
-- session. The kind is fixed at creation and checked on every request, so a token issued for
-- one transport is refused on the other (and gets that transport's lifetimes).
ALTER TABLE sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'cookie' CHECK (kind IN ('cookie', 'bearer'));

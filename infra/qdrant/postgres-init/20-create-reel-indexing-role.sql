\getenv app_password REEL_INDEXING_APP_PASSWORD

CREATE ROLE reel_indexing_app LOGIN PASSWORD :'app_password';
GRANT CONNECT, TEMPORARY ON DATABASE reel_indexing TO reel_indexing_app;
GRANT USAGE, CREATE ON SCHEMA public TO reel_indexing_app;
ALTER SCHEMA public OWNER TO reel_indexing_app;

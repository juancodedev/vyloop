-- Vyloop PostgreSQL initialization
-- Enable extensions required across the application

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- RLS-ready configuration (no policies yet — just extension groundwork)
-- pgcrypto provides gen_random_uuid() and hashing functions
-- uuid-ossp provides uuid_generate_v4() and related UUID functions

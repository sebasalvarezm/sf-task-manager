-- ============================================================
-- Reply search (November 2026). Run once in the Supabase SQL editor.
-- Seb's sent replies, each stored with a Voyage "meaning" vector, so the
-- Inbox can show the drafting model the 8 past replies closest to the email
-- being answered (instead of simply the 8 most recent).
-- Read-only use: nothing here sends mail or touches Salesforce.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS sent_replies (
  message_id   TEXT        PRIMARY KEY,          -- Outlook id of Seb's sent reply
  sent_at      TIMESTAMPTZ NOT NULL,
  to_name      TEXT,
  subject      TEXT,
  body         TEXT        NOT NULL,             -- his reply only, quoted history cut off
  theirs       TEXT,                             -- the message he was answering, when found (what gets matched)
  embedding    vector(512) NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS sent_replies_sent_at ON sent_replies (sent_at DESC);

-- The k replies whose vectors are closest to the query (cosine), best first.
CREATE OR REPLACE FUNCTION match_sent_replies(query_embedding vector(512), match_count INT DEFAULT 8)
RETURNS TABLE (message_id TEXT, sent_at TIMESTAMPTZ, to_name TEXT, subject TEXT, body TEXT, similarity FLOAT)
LANGUAGE sql STABLE AS $$
  SELECT message_id, sent_at, to_name, subject, body, 1 - (embedding <=> query_embedding) AS similarity
  FROM sent_replies
  ORDER BY embedding <=> query_embedding
  LIMIT match_count;
$$;

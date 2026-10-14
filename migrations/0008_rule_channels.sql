-- Each keyword automation chooses where it listens: comments, DMs, story
-- replies, or any mix. This replaces the single "keyword replies in DMs"
-- switch in DM tools (dm_features.keywordRepliesEnabled).
ALTER TABLE rules ADD COLUMN channels TEXT NOT NULL DEFAULT '["comments","dms"]';

-- Keep what each existing install already did. With the old switch on, every
-- automation also answered DMs and replies to stories that no story rule
-- matched. With it off (the default), or with no readable DM tools settings,
-- automations answered comments only.
UPDATE rules SET channels = CASE
  WHEN COALESCE((
    SELECT CASE WHEN json_valid(value) THEN json_extract(value, '$.keywordRepliesEnabled') END
    FROM automation_settings WHERE key = 'dm_features'
  ), 0) = 1 THEN '["comments","dms","stories"]'
  ELSE '["comments"]'
END;

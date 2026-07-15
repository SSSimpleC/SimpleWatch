ALTER TABLE media ADD COLUMN video_codec TEXT;
ALTER TABLE media ADD COLUMN playback_support TEXT NOT NULL DEFAULT 'unsupported';
ALTER TABLE media ADD COLUMN video_width INTEGER;
ALTER TABLE media ADD COLUMN video_height INTEGER;
ALTER TABLE media ADD COLUMN video_fps REAL;
ALTER TABLE media ADD COLUMN video_pixel_format TEXT;

ALTER TABLE token_jti ADD COLUMN room_id TEXT;
ALTER TABLE token_jti ADD COLUMN scope TEXT;

CREATE INDEX token_jti_room_scope_idx
  ON token_jti(room_id, scope, revoked_at, expires_at);

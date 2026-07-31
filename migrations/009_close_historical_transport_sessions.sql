-- 旧版在以 memberId='all' 完成 MediaMTX 踢出任务时，无法把实际会话
-- 标记为已关闭。只收口已经关闭房间中的遗留会话；活动房间不受影响。
UPDATE media_transport_sessions
SET closed_at = COALESCE(
  (
    SELECT rooms.closed_at
    FROM rooms
    WHERE rooms.id = media_transport_sessions.room_id
      AND rooms.status = 'closed'
  ),
  unixepoch('now') * 1000
)
WHERE closed_at IS NULL
  AND EXISTS (
    SELECT 1
    FROM rooms
    WHERE rooms.id = media_transport_sessions.room_id
      AND rooms.status = 'closed'
  );

// Only clients which reserve the durable ESO handoff before writing may release
// unwritten leases. Older clients wrote first, so reclaiming their rows is unsafe.
export async function releaseExpiredDepositMailCheckouts(db) {
  const [result]=await db.execute(`UPDATE guildsync_banking_entries
    SET mail_status = 'unsent', mail_batch_id = NULL, checked_out_by = NULL,
      checked_out_at = NULL, checkout_expires_at = NULL, failed_reason = NULL,
      mail_handoff_version = 0
    WHERE mail_status = 'checked_out' AND mail_handoff_version = 1
      AND checkout_expires_at <= NOW() AND written_to_eso_at IS NULL`);
  return Number(result.affectedRows || 0);
}

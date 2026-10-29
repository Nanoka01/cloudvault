export function formatBytes(bytes = 0) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** i;
  return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

const dateFmt = new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short', year: 'numeric' });
const dateTimeFmt = new Intl.DateTimeFormat('th-TH', {
  day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
});

export const formatDate = (iso) => (iso ? dateFmt.format(new Date(iso)) : '—');
export const formatDateTime = (iso) => (iso ? dateTimeFmt.format(new Date(iso)) : '—');

export function daysLeftInTrash(deletedAt, retention = 30) {
  const ms = new Date(deletedAt).getTime() + retention * 864e5 - Date.now();
  return Math.max(0, Math.ceil(ms / 864e5));
}

const TYPE_LABELS = {
  pdf: 'PDF', doc: 'Word', docx: 'Word', xls: 'Excel', xlsx: 'Excel', csv: 'CSV', ppt: 'PowerPoint',
  pptx: 'PowerPoint', txt: 'ข้อความ', zip: 'ZIP', jpg: 'รูปภาพ', jpeg: 'รูปภาพ', png: 'รูปภาพ', gif: 'รูปภาพ', mp4: 'วิดีโอ',
};
export const extOf = (name = '') => (name.includes('.') ? name.split('.').pop().toLowerCase() : '');
export const typeLabel = (name) => TYPE_LABELS[extOf(name)] || extOf(name).toUpperCase() || 'ไฟล์';

export const ACCEPT = '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.csv,.txt,.zip,.jpg,.jpeg,.png,.gif,.mp4';

export const SUBMISSION_STATUS = {
  PENDING: { label: 'รอตรวจ', tone: 'warn' },
  APPROVED: { label: 'ผ่าน', tone: 'good' },
  REJECTED: { label: 'ส่งกลับแก้ไข', tone: 'bad' },
  CANCELLED: { label: 'ยกเลิก', tone: 'muted' },
};

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { Brand } from '../components/ui.jsx';

// หน้าเข้าสู่ระบบ / สมัครสมาชิก
function AuthShell({ title, subtitle, children }) {
  return (
    <div className="auth-page">
      <Brand />
      <section className="auth-card">
        <h1>{title}</h1>
        <p className="muted">{subtitle}</p>
        {children}
      </section>
    </div>
  );
}

function useSubmit(fn) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const onSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await fn(new FormData(e.currentTarget));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return { error, setError, busy, onSubmit };
}

export function LoginPage() {
  const { signIn } = useAuth();
  const { error, busy, onSubmit } = useSubmit((f) =>
    signIn('/auth/login', { email: f.get('email'), password: f.get('password') }),
  );
  return (
    <AuthShell title="เข้าสู่ระบบ" subtitle="ใช้อีเมลที่สมัครไว้">
      <form onSubmit={onSubmit} className="form">
        <label className="field"><span>อีเมล</span><input name="email" type="email" autoComplete="email" required /></label>
        <label className="field"><span>รหัสผ่าน</span><input name="password" type="password" autoComplete="current-password" required /></label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="btn btn-primary btn-block" disabled={busy}>{busy ? 'กำลังเข้าสู่ระบบ…' : 'เข้าสู่ระบบ'}</button>
      </form>
      <p className="auth-switch">ยังไม่มีบัญชี? <Link to="/register">สมัครสมาชิก</Link></p>
    </AuthShell>
  );
}

export function RegisterPage() {
  const { signIn } = useAuth();
  const { error, busy, onSubmit } = useSubmit(async (f) => {
    if (f.get('password') !== f.get('confirm')) throw new Error('รหัสผ่านทั้งสองช่องไม่ตรงกัน');
    await signIn('/auth/register', { name: f.get('name'), email: f.get('email'), password: f.get('password') });
  });
  return (
    <AuthShell title="สร้างบัญชี" subtitle="ได้พื้นที่ส่วนตัว 5 GB ทันที สร้างหรือเข้าร่วมทีมทีหลังได้">
      <form onSubmit={onSubmit} className="form">
        <label className="field"><span>ชื่อที่แสดง</span><input name="name" autoComplete="name" required maxLength={80} /></label>
        <label className="field"><span>อีเมล</span><input name="email" type="email" autoComplete="email" required /></label>
        <label className="field"><span>รหัสผ่าน (อย่างน้อย 8 ตัว)</span><input name="password" type="password" minLength={8} autoComplete="new-password" required /></label>
        <label className="field"><span>ยืนยันรหัสผ่าน</span><input name="confirm" type="password" minLength={8} autoComplete="new-password" required /></label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="btn btn-primary btn-block" disabled={busy}>{busy ? 'กำลังสร้างบัญชี…' : 'สร้างบัญชี'}</button>
      </form>
      <p className="auth-switch">มีบัญชีแล้ว? <Link to="/login">เข้าสู่ระบบ</Link></p>
    </AuthShell>
  );
}

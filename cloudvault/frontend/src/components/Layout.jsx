import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { formatBytes } from '../utils.js';
import { Icon } from './ui.jsx';

export default function Layout() {
  const { user, companies, logout, refresh } = useAuth();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const pct = user ? Math.min(100, (user.usedBytes / user.quotaBytes) * 100) : 0;
  const searchable = ['/', '/trash', '/submitted'].includes(location.pathname);

  // อัปเดตพื้นที่ที่ใช้และรายชื่อบริษัททุกครั้งที่เปลี่ยนหน้า (เช่น หลังแอดมิน Approve พื้นที่จะลดลง)
  useEffect(() => {
    refresh().catch(() => {});
  }, [location.pathname, refresh]);

  const onSearch = (e) => {
    const q = e.target.value;
    if (!searchable) navigate(`/?q=${encodeURIComponent(q)}`);
    else setParams(q ? { q } : {}, { replace: true });
  };

  return (
    <div className={`app ${menuOpen ? 'menu-open' : ''}`}>
      <aside className="sidebar" onClick={(e) => e.target.closest('a') && setMenuOpen(false)}>
        <div className="brand">
          <Icon name="cloud" size={24} />
          <span>CloudVault</span>
        </div>

        <p className="nav-label">พื้นที่ของฉัน</p>
        <nav className="nav">
          <NavLink to="/" end><Icon name="folder" />My Files</NavLink>
          <NavLink to="/submitted"><Icon name="send" />งานที่ส่งแล้ว</NavLink>
          <NavLink to="/trash"><Icon name="trash" />ถังขยะ</NavLink>
        </nav>

        <p className="nav-label">บริษัท</p>
        <nav className="nav">
          {companies.map((c) => (
            <NavLink key={c.companyId} to={`/companies/${c.companyId}`}>
              <Icon name="building" />
              <span className="nav-text">{c.companyName}</span>
              {c.role === 'OWNER' && <span className="nav-tag">เจ้าของ</span>}
            </NavLink>
          ))}
          <NavLink to="/companies" end><Icon name="plus" />สร้าง / เข้าร่วมบริษัท</NavLink>
        </nav>

        <div className="storage-card">
          <div className="storage-head">
            <span>พื้นที่ของฉัน</span>
            <span className={pct > 90 ? 'text-bad' : 'muted'}>{Math.round(pct)}%</span>
          </div>
          <div className="meter"><div className={`meter-fill ${pct > 90 ? 'bad' : ''}`} style={{ width: `${pct}%` }} /></div>
          <p className="muted small">
            ใช้ไป {formatBytes(user?.usedBytes)} จาก {formatBytes(user?.quotaBytes)}
          </p>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <button className="icon-btn menu-btn" onClick={() => setMenuOpen((v) => !v)} aria-label="เมนู">
            <Icon name="menu" />
          </button>
          <label className="search">
            <Icon name="search" size={16} />
            <input
              type="search"
              placeholder="ค้นหาไฟล์ตามชื่อ…"
              value={searchable ? params.get('q') || '' : ''}
              onChange={onSearch}
            />
          </label>
          <div className="user-chip">
            <span className="avatar">{user?.name?.[0]?.toUpperCase()}</span>
            <span className="user-meta">
              <strong>{user?.name}</strong>
              <span className="muted small">{user?.email}</span>
            </span>
            <button className="icon-btn" onClick={logout} title="ออกจากระบบ" aria-label="ออกจากระบบ">
              <Icon name="logout" />
            </button>
          </div>
        </header>
        <main className="content">
          <Outlet />
        </main>
      </div>
      {menuOpen && <div className="scrim" onClick={() => setMenuOpen(false)} />}
    </div>
  );
}

import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './auth.jsx';
import Layout from './components/Layout.jsx';
import { Spinner } from './components/ui.jsx';
import { LoginPage, RegisterPage } from './pages/AuthPages.jsx';
import { TaskPage, TeamHome } from './pages/TeamPages.jsx';
import { MyFilesPage, SubmittedPage, TrashPage } from './pages/FilePages.jsx';
import SharePage from './pages/SharePage.jsx';

export default function App() {
  const { user, loading } = useAuth();
  const location = useLocation();
  // หน้าดาวน์โหลดลิงก์แชร์เปิดได้ทั้งคนที่ login และไม่ได้ login
  if (location.pathname.startsWith('/s/')) {
    return <Routes><Route path="/s/:token" element={<SharePage />} /></Routes>;
  }
  if (loading) return <div className="center-screen"><Spinner /></div>;

  if (!user) {
    return (
      <Routes>
        <Route path="/register" element={<RegisterPage />} />
        <Route path="*" element={<LoginPage />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<MyFilesPage />} />
        <Route path="trash" element={<TrashPage />} />
        <Route path="submitted" element={<SubmittedPage />} />
        <Route path="team" element={<TeamHome />} />
        <Route path="team/tasks/:taskId" element={<TaskPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

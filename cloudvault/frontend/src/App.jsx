import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth.jsx';
import Layout from './components/Layout.jsx';
import { Spinner } from './components/ui.jsx';
import { LoginPage, RegisterPage } from './pages/AuthPages.jsx';
import { CompaniesPage, CompanyPage, TaskPage } from './pages/CompanyPages.jsx';
import { MyFilesPage, SubmittedPage, TrashPage } from './pages/FilePages.jsx';

export default function App() {
  const { user, loading } = useAuth();
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
        <Route path="companies" element={<CompaniesPage />} />
        <Route path="companies/:companyId" element={<CompanyPage />} />
        <Route path="companies/:companyId/tasks/:taskId" element={<TaskPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

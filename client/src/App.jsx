import { Routes, Route, Navigate } from 'react-router';
import { UserProvider } from './context/UserContext';
import { SiteSettingsProvider } from './context/SiteSettingsContext';
import Layout from './components/Layout';
import HomePage from './pages/HomePage';
import CheckInPage from './pages/CheckInPage';
import ProfilePage from './pages/ProfilePage';
import LeaderboardPage from './pages/LeaderboardPage';

export default function App() {
  return (
    <SiteSettingsProvider>
      <UserProvider>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<HomePage />} />
            <Route path="/checkin" element={<CheckInPage />} />
            <Route path="/profile" element={<ProfilePage />} />
            <Route path="/leaderboard" element={<LeaderboardPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </UserProvider>
    </SiteSettingsProvider>
  );
}

import { createContext, useContext, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { setAnalyticsEnabled } from '../lib/analytics';

// Trùng giá trị mặc định ở server: trang hiển thị đúng ngay cả khi chưa tải xong hoặc API lỗi
const DEFAULTS = {
  headerTagline: 'Căn tin xanh — Ly cá nhân, Trái đất vui',
  heroTitle: 'Một ly nhựa ít hơn, một đại dương sạch hơn',
  seoDescription: 'GreenCanteen — Check-in ly/bình cá nhân tại căn tin, bảo vệ môi trường',
  announcementEnabled: false,
  announcementText: '',
  supportContact: '',
  analyticsEnabled: false,
};

const SiteSettingsContext = createContext(DEFAULTS);

export function SiteSettingsProvider({ children }) {
  const [settings, setSettings] = useState(DEFAULTS);

  useEffect(() => {
    let cancelled = false;
    api
      .siteSettings()
      .then((data) => {
        if (cancelled) return;
        setAnalyticsEnabled(data.analyticsEnabled);
        setSettings({ ...DEFAULTS, ...data });
      })
      .catch(() => {
        // Thiết lập chỉ là nội dung hiển thị: lỗi tải thì dùng mặc định, không ảnh hưởng chức năng
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return <SiteSettingsContext.Provider value={settings}>{children}</SiteSettingsContext.Provider>;
}

export const useSiteSettings = () => useContext(SiteSettingsContext);

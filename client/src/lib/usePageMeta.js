import { useEffect } from 'react';
import { useSiteSettings } from '../context/SiteSettingsContext';

const SITE_URL = (import.meta.env.VITE_SITE_URL || '').replace(/\/$/, '');

function setMeta(name, content) {
  let tag = document.head.querySelector(`meta[name="${name}"]`);
  if (!content) {
    tag?.remove();
    return;
  }
  if (!tag) {
    tag = document.createElement('meta');
    tag.setAttribute('name', name);
    document.head.appendChild(tag);
  }
  tag.setAttribute('content', content);
}

function setCanonical(path) {
  let tag = document.head.querySelector('link[rel="canonical"]');
  if (!SITE_URL || !path) {
    tag?.remove();
    return;
  }
  if (!tag) {
    tag = document.createElement('link');
    tag.setAttribute('rel', 'canonical');
    document.head.appendChild(tag);
  }
  tag.setAttribute('href', `${SITE_URL}${path}`);
}

/** Tiêu đề, mô tả, URL chuẩn của từng trang. Trang chỉ có nội dung cá nhân thì đánh dấu noindex. */
export function usePageMeta({ title, description, path, noindex = false }) {
  const { seoDescription } = useSiteSettings();

  useEffect(() => {
    document.title = title ? `${title} · GreenCanteen` : 'GreenCanteen — Check-in ly, bình cá nhân tại căn tin';
    setMeta('description', description || seoDescription);
    setMeta('robots', noindex ? 'noindex' : '');
    setCanonical(noindex ? '' : path);
  }, [title, description, seoDescription, path, noindex]);
}

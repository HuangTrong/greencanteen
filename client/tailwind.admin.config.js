import base from './tailwind.config.js';

/** @type {import('tailwindcss').Config} */
export default {
  ...base,
  content: ['./admin/index.html', './src/admin/**/*.{js,jsx}', './src/components/Avatar.jsx', './src/components/Modal.jsx', './src/components/StoryContent.jsx'],
};

/** @type {import('tailwindcss').Config} */
export default {
  // Khu quản trị có cấu hình riêng (tailwind.admin.config.js) để lớp CSS của nó không vào gói của sinh viên
  content: ['./index.html', './privacy.html', './data-deletion.html', './src/**/*.{js,jsx}', '!./src/admin/**'],
  theme: {
    extend: {
      colors: {
        leaf: {
          50: '#f0fdf4',
          100: '#dcfce7',
          200: '#bbf7d0',
          300: '#86efac',
          400: '#4ade80',
          500: '#22c55e',
          600: '#16a34a',
          700: '#15803d',
          800: '#166534',
          900: '#14532d',
        },
      },
      animation: {
        'pop-in': 'popIn 0.5s cubic-bezier(0.34, 1.56, 0.64, 1)',
        confetti: 'confetti 1.2s ease-out forwards',
        'fade-up': 'fadeUp 0.4s ease-out',
      },
      keyframes: {
        popIn: {
          '0%': { transform: 'scale(0.85)', opacity: '0' },
          '100%': { transform: 'scale(1)', opacity: '1' },
        },
        fadeUp: {
          '0%': { transform: 'translateY(12px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
        confetti: {
          '0%': { transform: 'translateY(0) rotate(0deg)', opacity: '1' },
          '100%': { transform: 'translateY(-80px) rotate(180deg)', opacity: '0' },
        },
      },
    },
  },
  plugins: [],
};

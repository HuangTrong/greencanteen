import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import AdminApp from './AdminApp';
import './admin.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter basename="/admin">
      <AdminApp />
    </BrowserRouter>
  </React.StrictMode>
);

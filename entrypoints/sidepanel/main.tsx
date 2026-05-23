import React from 'react';
import ReactDOM from 'react-dom/client';
import { ThemeProvider } from '../../lib/ThemeContext';
import App from './App';
import './style.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </React.StrictMode>,
);

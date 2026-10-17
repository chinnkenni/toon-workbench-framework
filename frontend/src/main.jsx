import React from 'react';
import {createRoot} from 'react-dom/client';
import {Theme} from '@radix-ui/themes';
import '@radix-ui/themes/styles.css';
import '../../public/style.css';
import '../../public/artist.css';
import './styles.css';
import App from './App.jsx';

createRoot(document.getElementById('root')).render(
 <Theme accentColor="jade" grayColor="slate" radius="medium" scaling="100%" appearance="light">
  <App/>
 </Theme>,
);

import { createBrowserRouter, Navigate, useLocation } from 'react-router';
import { AppLayout } from './layout/app-layout';
import { Journey } from '../screens/Journey';
import { Dns } from '../screens/Dns';
import { Handshake } from '../screens/Handshake';
import { Render } from '../screens/Render';

function ToJourney() {
  const loc = useLocation();
  return <Navigate to={{ pathname: '/journey', search: loc.search, hash: loc.hash }} replace />;
}

export const router = createBrowserRouter([
  {
    element: <AppLayout />,
    children: [
      { path: '/', element: <ToJourney /> },
      { path: '/journey', element: <Journey /> },
      { path: '/dns', element: <Dns /> },
      { path: '/handshake', element: <Handshake /> },
      { path: '/render', element: <Render /> },
      { path: '*', element: <ToJourney /> },
    ],
  },
]);

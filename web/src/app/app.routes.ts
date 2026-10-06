import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', loadComponent: () => import('./features/home/home').then((m) => m.Home) },
  { path: 'r/:roomId', loadComponent: () => import('./features/room/room').then((m) => m.Room) },
  { path: '**', redirectTo: '' },
];

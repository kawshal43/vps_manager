import { Folder, Terminal, Server, Layers, ArrowDownUp, Settings, Globe } from 'lucide-react'
import type { AppId } from '../../../shared/workspace'

export const apps = {
  websites: {
    name: 'Websites & Deployments',
    icon: Globe,
    color: 'green',
    description: 'Discover, update & restore websites',
    width: 1120,
    height: 690,
  },
  files: {
    name: 'Files',
    icon: Folder,
    color: 'gold',
    description: 'Your server files',
    width: 1000,
    height: 610,
  },
  terminal: {
    name: 'Terminal',
    icon: Terminal,
    color: 'slate',
    description: 'An interactive SSH shell',
    width: 860,
    height: 530,
  },
  server: {
    name: 'Server',
    icon: Server,
    color: 'blue',
    description: 'Health, services & logs',
    width: 980,
    height: 640,
  },
  applications: {
    name: 'Applications',
    icon: Layers,
    color: 'violet',
    description: 'Packages & deployments',
    width: 1060,
    height: 650,
  },
  transfers: {
    name: 'Transfers',
    icon: ArrowDownUp,
    color: 'green',
    description: 'Uploads & downloads',
    width: 780,
    height: 510,
  },
  settings: {
    name: 'Settings',
    icon: Settings,
    color: 'silver',
    description: 'Make yourself at home',
    width: 850,
    height: 600,
  },
} satisfies Record<
  AppId,
  {
    name: string
    icon: typeof Folder
    color: string
    description: string
    width: number
    height: number
  }
>

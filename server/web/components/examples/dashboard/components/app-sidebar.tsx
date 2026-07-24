import * as React from 'react';
import {
  ActivityIcon,
  BotIcon,
  BrainIcon,
  CalendarIcon,
  CheckSquareIcon,
  DownloadIcon,
  FileIcon,
  FileTextIcon,
  FolderIcon,
  HelpCircleIcon,
  LayoutDashboardIcon,
  NetworkIcon,
  SearchIcon,
  SettingsIcon,
} from 'lucide-react';

import { NavDocuments } from '@/components/examples/dashboard/components/nav-documents';
import { NavMain } from '@/components/examples/dashboard/components/nav-main';
import { NavSecondary } from '@/components/examples/dashboard/components/nav-secondary';
import { NavUser } from '@/components/examples/dashboard/components/nav-user';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@mantle/web-ui/ui/sidebar';

const data = {
  user: {
    name: 'Jason',
    email: 'jason@schoeman.me',
    avatar: '',
  },
  navMain: [
    {
      title: 'Overview',
      url: '#',
      icon: LayoutDashboardIcon,
    },
    {
      title: 'Memory',
      url: '#',
      icon: BrainIcon,
    },
    {
      title: 'Agents',
      url: '#',
      icon: BotIcon,
    },
    {
      title: 'Traces',
      url: '#',
      icon: ActivityIcon,
    },
    {
      title: 'Entities',
      url: '#',
      icon: NetworkIcon,
    },
    {
      title: 'Ingest',
      url: '#',
      icon: DownloadIcon,
    },
  ],
  navSecondary: [
    {
      title: 'Settings',
      url: '#',
      icon: SettingsIcon,
    },
    {
      title: 'Search',
      url: '#',
      icon: SearchIcon,
    },
    {
      title: 'Get Help',
      url: '#',
      icon: HelpCircleIcon,
    },
  ],
  documents: [
    {
      name: 'Notes',
      url: '#',
      icon: FileTextIcon,
    },
    {
      name: 'Pages',
      url: '#',
      icon: FileIcon,
    },
    {
      name: 'Events',
      url: '#',
      icon: CalendarIcon,
    },
    {
      name: 'Tasks',
      url: '#',
      icon: CheckSquareIcon,
    },
    {
      name: 'Files',
      url: '#',
      icon: FolderIcon,
    },
  ],
};

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  return (
    <Sidebar collapsible="offcanvas" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild className="data-[slot=sidebar-menu-button]:!p-1.5">
              <a href="#">
                <BrainIcon className="h-5 w-5" />
                <span className="text-base font-semibold">Mantle</span>
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <NavMain items={data.navMain} />
        <NavDocuments items={data.documents} />
        <NavSecondary items={data.navSecondary} className="mt-auto" />
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={data.user} />
      </SidebarFooter>
    </Sidebar>
  );
}

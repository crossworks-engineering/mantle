'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronsUpDown, Dices, LogOut, SunMoon, User as UserIcon } from 'lucide-react';
import { performSignOut } from '@mantle/web-ui/sign-out';
import { cn } from '@mantle/web-ui/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@mantle/web-ui/ui/dropdown-menu';
import { Avatar, AvatarFallback } from '@mantle/web-ui/ui/avatar';
import { GeneratedAvatar } from '@mantle/web-ui/generated-avatar';
import { ThemeModeItems } from '@mantle/web-ui/theme-toggle';
import { useColorTheme } from '@mantle/web-ui/color-theme-provider';
import { themeLabel } from '@mantle/web-ui/lib/themes';
import { RandomThemeItems } from '@/components/random-theme-toggle';
import { agentInitials } from '@/lib/agent-color';

export type ProfileIdentity = {
  /** The actor's display name, when they have set one. */
  displayName?: string | null;
  /** The actor's email — the fallback label, and the menu's secondary line. */
  email?: string | null;
  avatar?: { style: string; seed: string } | null;
};

/** Whichever of name/email is the better thing to call this person, plus the
 *  initials to fall back to when they have no generated avatar. */
function identityOf({ displayName, email }: ProfileIdentity) {
  const primary = displayName?.trim() || email?.trim() || 'Signed in';
  // Initials via the ONE shared algorithm (agentInitials): the profile
  // settings preview uses the same helper, so what a user sees there is what
  // the rail draws — a local variant here showed a different monogram for the
  // same person ("Ada B Lovelace" → AL in settings, AB in the rail). An email
  // has no whitespace, so it falls through to the first two characters
  // ("jason@…" → JA), the same shape as a one-word name.
  const initials = agentInitials(displayName?.trim() || email?.trim() || 'M');
  return { primary, initials };
}

/**
 * Who you are signed in as, and the two things you can do about it. The old
 * header's right-hand cluster, rebuilt as a row that fits a 16rem column.
 *
 * Two shapes, because the rail and the mobile bar want different things from
 * the same control:
 *  - `rail` — a full-width row: avatar, name, and the up/down chevron that says
 *    "this opens a menu". Collapses to the avatar alone in the icon rail, where
 *    the name has nowhere to go.
 *  - `bar` — the avatar alone, for the slim mobile bar.
 *
 * The identity shown is the ACTOR (see GET /api/shell): on a brain with more
 * than one login, this names the person at the keyboard rather than the account
 * that owns the data.
 */
export function ProfileMenu({
  identity,
  variant = 'rail',
  onNavigate,
}: {
  identity: ProfileIdentity;
  variant?: 'rail' | 'bar';
  onNavigate?: () => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const { primary, initials } = identityOf(identity);
  const { avatar, email } = identity;
  const { colorTheme } = useColorTheme();

  async function signOut() {
    setBusy(true);
    await performSignOut();
    router.push('/login');
    router.refresh();
  }

  const face = avatar ? (
    <GeneratedAvatar seed={avatar.seed} size={28} />
  ) : (
    <Avatar className="size-7">
      <AvatarFallback className="text-[10px] font-semibold">{initials}</AvatarFallback>
    </Avatar>
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title={primary}
          aria-label={`Account — ${primary}`}
          className={cn(
            'flex items-center rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring',
            'hover:bg-foreground/[0.06] data-[state=open]:bg-foreground/[0.06]',
            variant === 'rail'
              ? 'w-full gap-2.5 px-2 py-1.5 text-left group-data-[nav-collapsed=true]/shell:justify-center group-data-[nav-collapsed=true]/shell:gap-0 group-data-[nav-collapsed=true]/shell:px-0'
              : 'gap-1 p-1',
          )}
        >
          <span className="shrink-0">{face}</span>
          {variant === 'rail' && (
            <>
              <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground group-data-[nav-collapsed=true]/shell:hidden">
                {primary}
              </span>
              <ChevronsUpDown
                className="size-3.5 shrink-0 text-muted-foreground group-data-[nav-collapsed=true]/shell:hidden"
                aria-hidden
              />
            </>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align={variant === 'rail' ? 'start' : 'end'}
        side="bottom"
        className="w-56"
      >
        <DropdownMenuLabel className="font-normal">
          <span className="block truncate text-sm font-medium text-foreground">{primary}</span>
          {/* Only when it adds something: with no display name set, the primary
              line already IS the email and repeating it is noise. */}
          {email && email !== primary && (
            <span className="block truncate text-xs text-muted-foreground">{email}</span>
          )}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/settings/profile" onClick={onNavigate} className="cursor-pointer">
            <UserIcon className="size-4" /> Profile
          </Link>
        </DropdownMenuItem>

        {/* Appearance lives here rather than as its own rail row: it is a
            once-a-month decision sitting permanently in a column that has to
            hold the whole nav. Submenus, not nested DropdownMenus — a menu
            inside a menu ITEM opens a second popup that the parent's own
            dismiss logic then fights. */}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="cursor-pointer">
            <SunMoon className="size-4" /> Appearance
          </DropdownMenuSubTrigger>
          <DropdownMenuPortal>
            <DropdownMenuSubContent>
              <ThemeModeItems />
            </DropdownMenuSubContent>
          </DropdownMenuPortal>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="cursor-pointer">
            <Dices className="size-4" />
            <span className="flex-1">Theme</span>
            {/* The name the rail's theme row used to carry, kept as the
                trigger's trailing text so the current palette is still legible
                without opening anything. */}
            <span className="ml-2 max-w-24 truncate text-xs text-muted-foreground">
              {themeLabel(colorTheme)}
            </span>
          </DropdownMenuSubTrigger>
          <DropdownMenuPortal>
            <DropdownMenuSubContent className="w-52">
              <DropdownMenuLabel>Random theme</DropdownMenuLabel>
              <RandomThemeItems />
            </DropdownMenuSubContent>
          </DropdownMenuPortal>
        </DropdownMenuSub>
        <DropdownMenuSeparator />

        <DropdownMenuItem
          onClick={signOut}
          disabled={busy}
          className="cursor-pointer text-destructive-ink focus:text-destructive-ink"
        >
          <LogOut className="size-4" /> {busy ? 'Signing out…' : 'Sign out'}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

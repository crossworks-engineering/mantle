---
title: Logins on this device
---

## Logins on this device

This screen lists the logins this browser or desktop app holds, so you can
switch between them without signing in again. Open it from the profile menu
with **Manage logins…**.

It is not the list of people on a brain. That is **Settings > Users**, where
you also see every device a login is signed in on.

Each card shows the brain's name, the login's email and the brain's address.
**Active** marks the login you are using now. **Signed out** marks one that
needs a new sign-in.

Select a login to see its **Login**, **Name**, **Address**, when it was
**Added** and **Last used**, and **Stays signed in until**. Then:

- **Switch** moves you to that login (only for a login of the brain this app
  is open on).
- **Sign in again** appears on a signed-out login.
- **Sign out** tells its brain to end the login and removes it from this
  device. Signing out of the login you are using moves you to the next one
  held here, or to the sign-in screen. Other logins are not affected.
- **Forget** removes it from this device without telling its brain. Use it
  only for a brain that is gone. If the brain is still there, the login stays
  signed in on its side until it expires or is removed from its device list.

**Add** opens the sign-in screen to hold one more login here. An older desktop
app holds one login per brain; update it to hold several.

## Assistant

The assistant cannot see or change the logins held on your device. Use this
screen.

## Technical

- The list lives in this browser (or in the desktop app), not on any brain.
  The screen calls no brain API to show it; only Switch and Sign out reach a
  brain.
- The app renews every login held here each time it opens, so a login that
  is used stays signed in. **Stays signed in until** is what the device knows;
  the brain is the only judge of whether a login still works.
- A login signed in before this device could hold more than one is not
  listed. Sign out and in again once and it will be.

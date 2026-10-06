---
title: Microsoft
toolGroups: [files]
---

## Microsoft

Microsoft connects Microsoft 365 accounts, so OneDrive and SharePoint files and Outlook mail come into the brain without manual downloads.

It needs an app registration of your own in Azure AD. Mantle ships no shared one.

1. Under **Microsoft app (Azure AD)**, enter the **Application (client) ID**, **Client secret** and **Directory (tenant)**. Add the **Redirect URI** shown here to your app. Click **Save Microsoft app**.
2. Click **Connect** and sign in to Microsoft.
3. Click **Refresh drives**, then turn on sync for the drives you want. Use **Choose content** to pick folders.
4. Turn on **Outlook mail** to bring in mail. Only mail from your contacts is taken in.

**Disconnect** removes an account.

## Assistant

- "Find the signed contract on the SharePoint drive."
- "What's in the tender folder?"

Synced files are ordinary files in the brain, so ask about them like any upload.

## Technical

- Sign-in uses OAuth. Mantle keeps an encrypted refresh token, never your password. You can revoke access from Microsoft's side.
- Nothing syncs until you turn a drive on. Synced files go through the same reading and indexing as an upload, and their bytes are kept in the object store.
- Outlook mail passes the same contacts gate as IMAP mail.
- The app details can also come from environment variables. **Reset to environment** returns to them.

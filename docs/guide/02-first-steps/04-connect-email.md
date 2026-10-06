# Connect email

Connect a mailbox over IMAP so mail from your contacts becomes searchable memory.

Only mail from people on your **Contacts** list comes in, plus mail from your own addresses. Connecting a mailbox does not import the rest of it.

## Before you start

- A brain on the full shape. The [small core shape](../01-install/04-small-server.md) does not run the email worker.
- An app password from your mail provider. Turn on 2-step verification first, then create one in the provider's security settings (for Gmail: [App passwords](https://myaccount.google.com/apppasswords)).
- A Microsoft 365 or Outlook.com mailbox connects through **Settings > Microsoft** instead. See [Microsoft](../06-help/microsoft.md).

## Connect the mailbox

1. Open **Settings > Accounts** and click **Add**.
2. Fill in **Email address**, **IMAP host** (for Gmail, `imap.gmail.com`) and **Port** `993`, with **Use TLS** on.
3. Paste the app password into **App password**.
4. Optional: to let the assistant send from this address, fill in **SMTP host** and its **Port**: 465 with **Use TLS** on, or 587 with it off. It uses the same app password.
5. Set **Scan history (days)**: how far back the first sync looks. The default is 365; a shorter history makes the first sync faster.
6. Click **Test connection**. When it says **Connected.**, click **Connect & save**.

The first sync starts within two minutes.

## Let mail in with contacts

1. Open **Contacts** and add a person with their email address. An entry can also be a whole domain, such as `@example.com`, for everyone there.
2. Mantle brings in that sender's mail from now on, and also fetches their last 90 days or so.

To find who has been writing to you, open **Discover**. It lists recent senders who are not contacts yet. Click **Add as contact** to let one in.

## Check it worked

The mailbox shows in the **Accounts** list without an error. Mail from a contact appears under **Email**.

## If it fails

- **Test failed**: use the app password, not your normal password, and check the host and port.
- **The inbox stays empty**: you have no contacts yet. Add one.

## Next

- [Connect Telegram](05-connect-telegram.md)
- [Email and contacts](../03-using-jackdaw/03-email-and-contacts.md)

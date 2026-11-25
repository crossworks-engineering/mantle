# Where these test databases come from

Public test files, no client data. Each is copied as it was, under a new name.

| File               | Source                                                                                             | Licence    |
| ------------------ | -------------------------------------------------------------------------------------------------- | ---------- |
| `types.accdb`      | Jackcess, `src/test/data/V2010/testV2010.accdb` (github.com/jahlborn/jackcess)                     | Apache-2.0 |
| `complex.accdb`    | Jackcess, `src/test/data/V2010/complexDataTestV2010.accdb`                                         | Apache-2.0 |
| `calculated.accdb` | Jackcess, `src/test/data/V2010/calcFieldTestV2010.accdb`                                           | Apache-2.0 |
| `jet3.mdb`         | mdb-reader, `test/password/data/V1997_no-password.mdb` (github.com/andipaetzold/mdb-reader)        | MIT        |
| `encrypted.accdb`  | mdb-reader, `test/password/data/V2010_with-password.accdb` (an ACE file encrypted with a password) | MIT        |
| `password.mdb`     | mdb-reader, `test/password/data/V2003_with-password.mdb` (a Jet 4 file with a database password)   | MIT        |

mdb-reader says its test databases are copied from the Jackcess repository.

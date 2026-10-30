/**
 * Common passwords the box password policy refuses (password-rule.ts), bundled
 * so the check makes no outside call. Only entries of 8 or more characters:
 * a shorter one already fails the length rule. Compared lowercased; with trailing
 * digits and symbols taken off, the rest is compared to the base words below,
 * so `Password2024!` and `Welcome1` are caught. Kept short on purpose: the length rule does most of the work
 * (plan "Corporate sign-in", section 6.4: no symbol rules).
 */
const LIST = `
password passw0rd p@ssw0rd p@ssword passwort motdepasse contrasena wachtwoord
password1 password12 password123 password1234 password12345 password123456
mypassword newpassword yourpassword thepassword secretpassword adminpassword
changeme changeme1 changeme123 changeit letmein1 letmein123 welcome1 welcome123
welcome2024 welcome2025 welcome2026 administrator admin1234 admin12345 admin123456
administrator1 rootroot rootpassword superuser supervisor sysadmin
12345678 123456789 1234567890 12345678910 123123123 1234512345 123321123
11111111 111111111 1111111111 00000000 000000000 0000000000 99999999 88888888
87654321 987654321 9876543210 11223344 12341234 12121212 13131313 69696969
11112222 22222222 33333333 44444444 55555555 66666666 77777777 147258369
123456789a 123456789q 1q2w3e4r 1q2w3e4r5t 1q2w3e4r5t6y 1qaz2wsx 1qaz2wsx3edc
qwertyui qwertyuiop qwerty12 qwerty123 qwerty1234 qwerty123456 qwertz123
asdfghjk asdfghjkl asdf1234 zxcvbnm1 zxcvbnmm qazwsxedc qweasdzxc qwe123qwe
abcd1234 abcdefgh abcdefg1 abc12345 abc123456 aa123456 a1b2c3d4 a12345678
iloveyou iloveyou1 iloveyou2 loveyou1 lovelove sweetheart sunshine sunshine1
princess princess1 football football1 baseball basketball soccer12 hockey12
superman batman123 starwars starwars1 pokemon1 pokemon123 minecraft whatever
trustno1 freedom1 dragon12 dragon123 monkey12 monkey123 shadow12 master12
master123 michael1 jennifer jordan23 charlie1 computer computer1 internet
football12 liverpool chelsea1 arsenal1 manchester barcelona realmadrid
corvette mercedes ferrari1 porsche1 mustang1 harley12 yankees1 cowboys1
summer12 summer2024 summer2025 winter12 winter2024 winter2025 spring2025
autumn2025 january1 february october1 november december
company1 company123 business security security1 password! qwerty!!
temp1234 temppass temporary default1 guest123 testtest test1234 test12345
testing1 testing123 demo1234 sample123 example1 letmeinnow opensesame
access14 accessme hello123 hello1234 helloworld goodluck1 blessed1 jesus123
godisgood heaven12 angel123 killer12 hunter12 ranger12
silver12 golden12 diamond1 matrix12 phoenix1 thunder1 lightning
`;

export const COMMON_PASSWORDS: ReadonlySet<string> = new Set(
  LIST.split(/\s+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length >= 8),
);

/** Words that make a common password with digits or symbols after them
 *  (`Welcome2026!`, `Qwerty123`): the stripped form is compared to these. */
const BASE = `
password passw0rd p@ssw0rd passwort welcome letmein changeme admin
administrator root qwerty qwertz azerty asdf zxcvbnm iloveyou monkey dragon
master shadow sunshine princess football baseball superman batman starwars
pokemon summer winter spring autumn company secret test guest default
hello abc abcd abcdef trustno freedom computer internet
`;

export const COMMON_PASSWORD_BASES: ReadonlySet<string> = new Set(
  BASE.split(/\s+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

'use client';

import { Avatar, AvatarFallback } from '@mantle/web-ui/ui/avatar';
import { Button } from '@mantle/web-ui/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@mantle/web-ui/ui/card';
import { Input } from '@mantle/web-ui/ui/input';
import { Label } from '@mantle/web-ui/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@mantle/web-ui/ui/select';
import { Separator } from '@mantle/web-ui/ui/separator';

const people = [
  { name: 'Jason Schoeman', detail: 'Owner', initials: 'JS' },
  { name: 'Saskia', detail: 'Assistant', initials: 'Sa' },
  { name: 'Remy', detail: 'Memory recall', initials: 'Re' },
  { name: 'Researcher', detail: 'Web search', initials: 'Rs' },
];

export function CardsShare() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Share this page</CardTitle>
        <CardDescription>Anyone with the link can read this page.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-2">
          <Label htmlFor="link" className="sr-only">
            Link
          </Label>
          <Input
            id="link"
            value="https://mantle.local/p/memory-architecture"
            className="h-8"
            readOnly
          />
          <Button size="sm" variant="outline" className="shadow-none">
            Copy Link
          </Button>
        </div>
        <Separator className="my-4" />
        <div className="flex flex-col gap-4">
          <div className="text-sm font-medium">People &amp; agents with access</div>
          <div className="grid gap-6">
            {people.map((person) => (
              <div key={person.name} className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-4">
                  <Avatar>
                    <AvatarFallback className="text-xs">{person.initials}</AvatarFallback>
                  </Avatar>
                  <div>
                    <p className="text-sm leading-none font-medium">{person.name}</p>
                    <p className="text-muted-foreground text-sm">{person.detail}</p>
                  </div>
                </div>
                <Select defaultValue="edit">
                  <SelectTrigger className="ml-auto pr-2" aria-label="Access level">
                    <SelectValue placeholder="Select" />
                  </SelectTrigger>
                  <SelectContent align="end">
                    <SelectItem value="edit">Can edit</SelectItem>
                    <SelectItem value="view">Can view</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

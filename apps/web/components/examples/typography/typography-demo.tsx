import { BlogPost } from './blog-post';
import { DemoFontShowcase } from './font-showcase';
import { TypographyFontControls } from '@/components/appearance/typography-font-controls';

export default function TypographyDemo() {
  return (
    <div className="@container relative grid grid-cols-9 gap-4 p-4">
      <div className="sticky top-4 hidden max-h-[calc(100vh-2rem)] flex-col gap-4 overflow-y-auto pr-1 lg:col-span-3 lg:flex">
        {/* Font selectors sit above the Font Showcase — pick a wordmark/title
            face, then compare against the theme's type specimens below. */}
        <TypographyFontControls />
        <DemoFontShowcase />
      </div>
      <div className="col-span-9 lg:col-span-6">
        <BlogPost />
      </div>
    </div>
  );
}

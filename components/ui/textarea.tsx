import * as React from "react"
import { cn } from "cn"

/**
 * The shared look of text fields that are not the Input component: textareas and native
 * selects. Focus uses the global 2px outline (app/globals.css).
 */
const fieldClassName =
  "w-full min-w-0 rounded-[10px] border border-input bg-paper px-3 py-2 text-base transition-[border-color] placeholder:text-muted-foreground hover:border-line-stronger focus-visible:border-ring disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive md:text-sm"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(fieldClassName, "min-h-20", className)}
      {...props}
    />
  )
}

export { Textarea, fieldClassName }

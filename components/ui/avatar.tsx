"use client"

import * as React from "react"
import { cn } from "cn"
import { Avatar as AvatarPrimitive } from "radix-ui"

// Gudz avatar: a rounded square for organizations and accounts, a circle for people
// (`shape="circle"`). Falls back to initials on canvas when there is no image.

function Avatar({
  className,
  shape = "square",
  ...props
}: React.ComponentProps<typeof AvatarPrimitive.Root> & { shape?: "square" | "circle" }) {
  return (
    <AvatarPrimitive.Root
      data-slot="avatar"
      className={cn(
        "relative flex size-8 shrink-0 overflow-hidden border border-line bg-canvas",
        shape === "circle" ? "rounded-full" : "rounded-[28%]",
        className
      )}
      {...props}
    />
  )
}

function AvatarImage({
  className,
  ...props
}: React.ComponentProps<typeof AvatarPrimitive.Image>) {
  return (
    <AvatarPrimitive.Image
      data-slot="avatar-image"
      className={cn("aspect-square size-full object-cover", className)}
      {...props}
    />
  )
}

function AvatarFallback({
  className,
  ...props
}: React.ComponentProps<typeof AvatarPrimitive.Fallback>) {
  return (
    <AvatarPrimitive.Fallback
      data-slot="avatar-fallback"
      className={cn(
        "flex size-full items-center justify-center text-xs font-medium text-ink-2",
        className
      )}
      {...props}
    />
  )
}

export { Avatar, AvatarFallback, AvatarImage }

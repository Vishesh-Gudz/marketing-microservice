"use client";

import { useId } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

/**
 * A toolbar select that shows its label inside the control ("Level  Accounts"), like the
 * filter bar. The accessible name is the plain label, from a visually hidden element.
 */
export function LabelledSelect({
  label,
  value,
  options,
  onValueChange,
  className,
}: {
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onValueChange: (value: string) => void;
  className?: string;
}) {
  const id = useId();
  return (
    <div className="grid">
      <span id={id} className="sr-only">
        {label}
      </span>
      <Select value={value} onValueChange={onValueChange}>
        <SelectTrigger size="sm" className={cn("min-w-40", className)} aria-labelledby={id}>
          <span aria-hidden="true" className="text-muted-foreground">
            {label}
          </span>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

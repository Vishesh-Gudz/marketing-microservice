"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { useId } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * Rows per page plus Previous / Next under a cursor-paginated table. The caller owns the
 * cursor stack; this only renders the controls.
 */
export function TablePager({
  sizes,
  numItems,
  onNumItemsChange,
  pageNumber,
  onPrevious,
  onNext,
  nextDisabled,
}: {
  sizes: readonly number[];
  numItems: number;
  onNumItemsChange: (numItems: number) => void;
  pageNumber: number;
  onPrevious: () => void;
  onNext: () => void;
  nextDisabled: boolean;
}) {
  const pageSizeLabelId = useId();
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
      <div className="flex items-center gap-2">
        <span id={pageSizeLabelId} className="text-muted-foreground">
          Rows per page
        </span>
        <Select value={String(numItems)} onValueChange={(value) => onNumItemsChange(Number(value))}>
          <SelectTrigger size="sm" aria-labelledby={pageSizeLabelId} className="w-20">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {sizes.map((size) => (
              <SelectItem key={size} value={String(size)}>
                {size}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground" aria-live="polite">
          Page {pageNumber}
        </span>
        <Button variant="outline" size="sm" disabled={pageNumber === 1} onClick={onPrevious}>
          <ChevronLeft aria-hidden="true" />
          Previous
        </Button>
        <Button variant="outline" size="sm" disabled={nextDisabled} onClick={onNext}>
          Next
          <ChevronRight aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}

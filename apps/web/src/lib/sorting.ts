"use client";
/** nuqs parser for tanstack sorting state — upstream stores `JSON.stringify([{id,desc}])` in `?sort=`. */
import { createParser } from "nuqs";
import type { SortingState } from "@tanstack/react-table";

export const getSortingStateParser = () =>
  createParser<SortingState>({
    parse(value) {
      if (!value) return null;
      try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? (parsed as SortingState) : null;
      } catch {
        return null;
      }
    },
    serialize(value) {
      return JSON.stringify(value);
    },
  });

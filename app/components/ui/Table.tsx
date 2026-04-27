import type { ReactNode, HTMLAttributes } from "react";

export function Table({
  className = "",
  children,
  ...rest
}: HTMLAttributes<HTMLTableElement>) {
  return (
    <div className="w-full overflow-x-auto rounded-lg border border-line">
      <table
        className={`min-w-full text-sm text-ink ${className}`}
        {...rest}
      >
        {children}
      </table>
    </div>
  );
}

Table.Head = function TableHead({ children }: { children: ReactNode }) {
  return (
    <thead className="bg-surface-3 text-xs uppercase tracking-widest text-ink-muted">
      {children}
    </thead>
  );
};

Table.HeadRow = function TableHeadRow({ children }: { children: ReactNode }) {
  return <tr>{children}</tr>;
};

Table.HeadCell = function TableHeadCell({
  className = "",
  children,
  ...rest
}: HTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      scope="col"
      className={`px-4 py-2.5 text-left font-semibold whitespace-nowrap ${className}`}
      {...rest}
    >
      {children}
    </th>
  );
};

Table.Body = function TableBody({ children }: { children: ReactNode }) {
  return <tbody className="divide-y divide-line">{children}</tbody>;
};

Table.Row = function TableRow({
  className = "",
  children,
  ...rest
}: HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr
      className={`hover:bg-surface-3 transition-colors ${className}`}
      {...rest}
    >
      {children}
    </tr>
  );
};

Table.Cell = function TableCell({
  className = "",
  children,
  ...rest
}: HTMLAttributes<HTMLTableCellElement>) {
  return (
    <td className={`px-4 py-3 align-top ${className}`} {...rest}>
      {children}
    </td>
  );
};

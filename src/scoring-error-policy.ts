const modelRoutingPatterns = [
  "%model_not_found%",
  "%model not found%",
  "%model_no_found%",
  "%model no found%",
  "%moddel_no_found%",
  "%model does not exist%",
  "%model doesn't exist%",
  "%unknown model%",
  "%no such model%",
  "%unsupported model%",
  "%not supported by any configured account%",
  "%no available channel for model%",
];

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export const modelRoutingPatternsSql = `ARRAY[${modelRoutingPatterns.map(sqlLiteral).join(", ")}]`;

//! Constrained condition expressions (Milestone 3).
//!
//! A condition is a small boolean formula over string variables:
//!
//! ```text
//! node.review1.severity contains "P0" or node.review2.severity contains "P0"
//! command.exitCode == 0
//! input.branch != "main"
//! ```
//!
//! There is intentionally no scripting: no arithmetic, no function calls, no
//! property access beyond dotted variable names, no shell. The left side of
//! each clause is always a variable reference resolved from run variables;
//! the right side is always a literal (optionally double-quoted).

use crate::workflow::{ConditionClause, ConditionConfig, ConditionLogic, ConditionOp};
use std::collections::HashMap;

/// Parse text into a [`ConditionConfig`]. Clauses join with a single logic
/// (`and` / `or`); mixing both in one expression is rejected.
pub fn parse_condition(text: &str) -> Result<ConditionConfig, String> {
    let tokens = tokenize(text)?;
    if tokens.is_empty() {
        return Err("Condition must not be empty.".to_string());
    }
    // Split on top-level and/or connectors.
    let mut clauses = Vec::new();
    let mut logic: Option<ConditionLogic> = None;
    let mut current: Vec<String> = Vec::new();
    let mut tokens = tokens.into_iter().peekable();
    while let Some((token, quoted)) = tokens.next() {
        let lower = token.to_ascii_lowercase();
        // The two-word `not contains` operator, as the TypeScript parser reads it.
        if !quoted
            && lower == "not"
            && tokens
                .peek()
                .is_some_and(|(next, q)| !q && next.eq_ignore_ascii_case("contains"))
        {
            tokens.next();
            current.push("not contains".to_string());
            continue;
        }
        if !quoted && (lower == "and" || lower == "or") {
            if current.is_empty() {
                return Err("Condition has a dangling 'and'/'or'.".to_string());
            }
            clauses.push(parse_clause(&current)?);
            current.clear();
            let this = if lower == "and" {
                ConditionLogic::And
            } else {
                ConditionLogic::Or
            };
            match logic {
                None => logic = Some(this),
                Some(existing) if existing != this => {
                    return Err(
                        "Mixing 'and' and 'or' needs explicit grouping, which is not supported. Split into nested conditions.".to_string(),
                    );
                }
                _ => {}
            }
            continue;
        }
        current.push(token);
    }
    if current.is_empty() {
        return Err("Condition ends with a dangling 'and'/'or'.".to_string());
    }
    clauses.push(parse_clause(&current)?);
    Ok(ConditionConfig {
        logic: logic.unwrap_or(ConditionLogic::And),
        clauses,
    })
}

/// Render a [`ConditionConfig`] back to canonical text.
pub fn render_condition(config: &ConditionConfig) -> String {
    let joiner = match config.logic {
        ConditionLogic::And => " and ",
        ConditionLogic::Or => " or ",
    };
    config
        .clauses
        .iter()
        .map(|c| {
            let right = if needs_quotes(&c.right) {
                format!("\"{}\"", c.right.replace('\\', "\\\\").replace('"', "\\\""))
            } else {
                c.right.clone()
            };
            format!("{} {} {}", c.left, c.op.symbol(), right)
        })
        .collect::<Vec<_>>()
        .join(joiner)
}

/// Evaluate a condition against run variables. Missing left-hand variables
/// and non-numeric operands for comparisons are errors (fail closed: the
/// caller records the node as failed rather than guessing a branch).
pub fn eval_condition(
    config: &ConditionConfig,
    vars: &HashMap<String, String>,
) -> Result<bool, String> {
    if config.clauses.is_empty() {
        return Err("Condition has no clauses.".to_string());
    }
    let mut results = Vec::with_capacity(config.clauses.len());
    for clause in &config.clauses {
        results.push(eval_clause(clause, vars)?);
    }
    Ok(match config.logic {
        ConditionLogic::And => results.into_iter().all(|b| b),
        ConditionLogic::Or => results.into_iter().any(|b| b),
    })
}

fn eval_clause(clause: &ConditionClause, vars: &HashMap<String, String>) -> Result<bool, String> {
    let left = vars.get(&clause.left).ok_or_else(|| {
        format!(
            "Unknown variable '{}'. Available: workflow.*, input.*, node.*.",
            clause.left
        )
    })?;
    let right = &clause.right;
    Ok(match clause.op {
        ConditionOp::Equals => left == right,
        ConditionOp::NotEquals => left != right,
        ConditionOp::Contains => left.contains(right.as_str()),
        ConditionOp::NotContains => !left.contains(right.as_str()),
        ConditionOp::Greater
        | ConditionOp::Less
        | ConditionOp::GreaterOrEqual
        | ConditionOp::LessOrEqual => {
            let l: f64 = left
                .trim()
                .parse()
                .map_err(|_| format!("'{}' is not numeric (value '{}').", clause.left, left))?;
            let r: f64 = right
                .trim()
                .parse()
                .map_err(|_| format!("Right side '{right}' is not numeric."))?;
            match clause.op {
                ConditionOp::Greater => l > r,
                ConditionOp::Less => l < r,
                ConditionOp::GreaterOrEqual => l >= r,
                ConditionOp::LessOrEqual => l <= r,
                _ => unreachable!("numeric branch"),
            }
        }
    })
}

fn parse_clause(tokens: &[String]) -> Result<ConditionClause, String> {
    if tokens.len() < 3 {
        return Err(format!(
            "Clause '{}' needs the form `<variable> <operator> <value>`.",
            tokens.join(" ")
        ));
    }
    if tokens.len() > 3 {
        return Err(format!(
            "Clause '{}' has extra text. Quote values containing spaces.",
            tokens.join(" ")
        ));
    }
    let left = tokens[0].clone();
    if !is_reference(&left) {
        return Err(format!(
            "Left side '{left}' must be a variable like node.review1.severity, input.branch, or workflow.name."
        ));
    }
    let op = ConditionOp::parse(&tokens[1]).ok_or_else(|| {
        format!(
            "Unknown operator '{}'. Use one of ==, !=, contains, not contains, >, <, >=, <=.",
            tokens[1]
        )
    })?;
    Ok(ConditionClause {
        left,
        op,
        right: tokens[2].clone(),
    })
}

fn is_reference(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.split('.').all(|seg| {
            !seg.is_empty()
                && seg
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        })
}

/// Quote what the parser would otherwise split or unescape, and a value that
/// reads as a connector.
fn needs_quotes(s: &str) -> bool {
    s.is_empty()
        || s.chars()
            .any(|c| c.is_whitespace() || c == '"' || c == '\\')
        || s.eq_ignore_ascii_case("and")
        || s.eq_ignore_ascii_case("or")
}

/// Split text into tokens, honouring double quotes (with backslash escapes).
/// Each token says whether it was quoted: a quoted one is always a value.
fn tokenize(text: &str) -> Result<Vec<(String, bool)>, String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut chars = text.chars().peekable();
    let mut in_quotes = false;
    let mut in_token = false;
    let mut quoted = false;
    while let Some(c) = chars.next() {
        if in_quotes {
            if c == '\\' {
                match chars.next() {
                    Some(escaped) => current.push(escaped),
                    None => return Err("Condition ends with a dangling escape.".to_string()),
                }
            } else if c == '"' {
                in_quotes = false;
            } else {
                current.push(c);
            }
            continue;
        }
        match c {
            '"' => {
                in_quotes = true;
                in_token = true;
                quoted = true;
            }
            c if c.is_whitespace() => {
                if in_token {
                    tokens.push((std::mem::take(&mut current), quoted));
                    in_token = false;
                    quoted = false;
                }
            }
            _ => {
                current.push(c);
                in_token = true;
            }
        }
    }
    if in_quotes {
        return Err("Condition has an unterminated quote.".to_string());
    }
    if in_token {
        tokens.push((current, quoted));
    }
    Ok(tokens)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect()
    }

    #[test]
    fn rendering_round_trips_every_value() {
        for right in ["a b\\c", "or", "AND", "x\\\"y z", "\"", "C:\\path", "plain"] {
            let config = ConditionConfig {
                logic: ConditionLogic::And,
                clauses: vec![ConditionClause {
                    left: "input.x".into(),
                    op: ConditionOp::Equals,
                    right: right.into(),
                }],
            };
            let text = render_condition(&config);
            assert_eq!(parse_condition(&text), Ok(config), "{right} -> {text}");
        }
        let joined = parse_condition(r#"input.a == "or" or input.b == and2"#).unwrap();
        assert_eq!(joined.clauses.len(), 2);
        // Both sides read the two-word operator, and neither reads it quoted
        // as two values.
        let not = parse_condition(r#"input.a not contains "P0""#).unwrap();
        assert_eq!(not.clauses[0].op, ConditionOp::NotContains);
        assert!(parse_condition(r#"input.a "not" "contains" x"#).is_err());
    }

    #[test]
    fn parses_and_evaluates_contains() {
        let config = parse_condition(r#"review.severity contains "P0""#).expect("parse");
        assert_eq!(config.clauses.len(), 1);
        assert!(eval_condition(&config, &vars(&[("review.severity", "P0 found")])).expect("eval"));
        assert!(!eval_condition(&config, &vars(&[("review.severity", "clean")])).expect("eval"));
    }

    #[test]
    fn equality_and_inequality() {
        let eq = parse_condition("command.exitCode == 0").expect("parse");
        assert!(eval_condition(&eq, &vars(&[("command.exitCode", "0")])).expect("eval"));
        let ne = parse_condition("input.branch != main").expect("parse");
        assert!(eval_condition(&ne, &vars(&[("input.branch", "dev")])).expect("eval"));
    }

    #[test]
    fn numeric_comparisons() {
        let gt = parse_condition("node.n.exitCode > 0").expect("parse");
        assert!(eval_condition(&gt, &vars(&[("node.n.exitCode", "2")])).expect("eval"));
        assert!(!eval_condition(&gt, &vars(&[("node.n.exitCode", "0")])).expect("eval"));
    }

    #[test]
    fn or_logic() {
        let config = parse_condition(r#"a contains "P0" or b contains "P1""#).expect("parse");
        assert_eq!(config.logic, ConditionLogic::Or);
        assert!(eval_condition(&config, &vars(&[("a", "x"), ("b", "P1")])).expect("eval"));
        assert!(!eval_condition(&config, &vars(&[("a", "x"), ("b", "y")])).expect("eval"));
    }

    #[test]
    fn mixed_and_or_rejected() {
        assert!(parse_condition(r#"a == "1" and b == "2" or c == "3""#).is_err());
    }

    #[test]
    fn unknown_operator_rejected() {
        assert!(parse_condition("a ~= b").is_err());
    }

    #[test]
    fn missing_variable_is_error() {
        let config = parse_condition("node.ghost.output == x").expect("parse");
        assert!(eval_condition(&config, &vars(&[])).is_err());
    }

    #[test]
    fn round_trips_through_render() {
        for text in [
            r#"node.r.severity contains "P0""#,
            "command.exitCode == 0",
            "a != b or c != d",
        ] {
            let config = parse_condition(text).expect("parse");
            let rendered = render_condition(&config);
            let reparsed = parse_condition(&rendered).expect("reparse");
            assert_eq!(config, reparsed, "round trip for {text}");
        }
    }
}

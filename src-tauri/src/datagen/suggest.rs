//! Picking the DEFAULT generator for a column, from its data type and its name.

use serde_json::{Value, json};

use super::meta::{ColMeta, FkMeta};

// ===================== Generator suggestion =====================

pub(super) fn type_family(data_type: &str) -> &'static str {
    let t = data_type.to_lowercase();
    let base = t.split(['(', ' ']).next().unwrap_or("");
    // `ext.vector(3)`: an extension type in another schema keeps its qualifier.
    let base = base.rsplit('.').next().unwrap_or(base).to_string();
    match base.as_str() {
        "tinyint" if t.starts_with("tinyint(1)") => "bool",
        "bool" | "boolean" | "bit" => "bool",
        "tinyint" | "smallint" | "mediumint" | "int" | "integer" | "int2" | "int4" | "serial"
        | "smallserial" => "int",
        "bigint" | "int8" | "bigserial" => "bigint",
        "decimal" | "numeric" | "money" => "decimal",
        "float" | "double" | "real" | "float4" | "float8" => "float",
        "date" => "date",
        "time" | "timetz" => "time",
        "datetime" | "timestamp" | "timestamptz" => "datetime",
        "year" => "year",
        "json" | "jsonb" => "json",
        "uuid" => "uuid",
        "blob" | "bytea" | "binary" | "varbinary" | "longblob" | "mediumblob" | "tinyblob" => {
            "blob"
        }
        "enum" | "set" => "enum",
        // pgvector. Checked on the last segment too: the type may come back schema-qualified.
        "vector" | "halfvec" => "vector",
        "sparsevec" => "sparsevec",
        "text" | "mediumtext" | "longtext" | "tinytext" | "clob" => "text",
        "char" | "varchar" | "character" | "nchar" | "nvarchar" | "citext" => "string",
        _ => {
            if t.contains("char") || t.contains("text") {
                "string"
            } else if t.contains("int") {
                "int"
            } else {
                "string"
            }
        }
    }
}

/// `vector(1536)` -> 1536.
pub(super) fn declared_dims(data_type: &str) -> Option<usize> {
    let open = data_type.rfind('(')?;
    let close = data_type.rfind(')')?;
    data_type.get(open + 1..close)?.trim().parse().ok()
}

/// Best-effort default generator for a column. Order matters: FK beats everything (it is the
/// only choice that keeps the data valid), then identity columns, then the column NAME (this is
/// what makes the dialog usable without configuring anything), then the declared type.
pub fn suggest_generator(col: &ColMeta, fk: Option<&FkMeta>) -> (String, Value) {
    if let Some(fk) = fk {
        return (
            "foreignKey".to_string(),
            json!({ "refTable": fk.ref_table, "refColumn": fk.ref_column }),
        );
    }
    if col.auto_inc {
        return ("skip".to_string(), json!({}));
    }

    let family = type_family(&col.data_type);
    if family == "enum" && !col.enum_values.is_empty() {
        return (
            "enumValues".to_string(),
            json!({ "values": col.enum_values }),
        );
    }
    if !col.enum_values.is_empty() {
        return (
            "enumValues".to_string(),
            json!({ "values": col.enum_values }),
        );
    }

    let name = col.name.to_lowercase();
    let textual = matches!(family, "string" | "text");
    let has = |needle: &str| name.contains(needle);
    let max_len = col.max_len.unwrap_or(255);

    if textual {
        if has("email") || has("e_mail") {
            return ("email".to_string(), json!({}));
        }
        if name == "password" || has("passwd") || has("password") || has("pwd") {
            return ("password".to_string(), json!({ "length": 12 }));
        }
        if has("first_name") || name == "firstname" || name == "fname" || has("given_name") {
            return ("firstName".to_string(), json!({}));
        }
        if has("last_name")
            || name == "lastname"
            || name == "lname"
            || has("surname")
            || has("family_name")
        {
            return ("lastName".to_string(), json!({}));
        }
        if has("full_name")
            || name == "name"
            || has("username")
            || name == "user"
            || has("display_name")
        {
            return (
                if has("username") || name == "user" {
                    "username".to_string()
                } else {
                    "fullName".to_string()
                },
                json!({}),
            );
        }
        if has("phone") || has("mobile") || has("tel") {
            return ("phone".to_string(), json!({}));
        }
        if has("city") || has("district") || has("province") {
            return ("city".to_string(), json!({}));
        }
        if has("country_code") {
            return ("countryCode".to_string(), json!({}));
        }
        if has("country") {
            return ("country".to_string(), json!({}));
        }
        if has("zip") || has("postal") {
            return ("zipCode".to_string(), json!({}));
        }
        if has("address") || has("street") {
            return ("address".to_string(), json!({}));
        }
        if has("company") || has("organization") || has("employer") {
            return ("company".to_string(), json!({}));
        }
        if has("department") {
            return ("department".to_string(), json!({}));
        }
        if has("job") || has("position") || has("role_name") {
            return ("jobTitle".to_string(), json!({}));
        }
        if has("currency") {
            return ("currencyCode".to_string(), json!({}));
        }
        if has("timezone") || has("time_zone") {
            return ("timezone".to_string(), json!({}));
        }
        if has("url") || has("website") || has("link") || has("avatar") || has("image") {
            return ("url".to_string(), json!({}));
        }
        if name == "ip" || has("ip_address") || name.ends_with("_ip") {
            return ("ipv4".to_string(), json!({}));
        }
        if has("mac") {
            return ("macAddress".to_string(), json!({}));
        }
        if has("color") || has("colour") {
            return ("hexColor".to_string(), json!({}));
        }
        if has("uuid") || has("guid") {
            return ("uuid".to_string(), json!({}));
        }
        if has("mime") {
            return ("mimeType".to_string(), json!({}));
        }
        if has("file_name") || has("filename") {
            return ("fileName".to_string(), json!({}));
        }
        if has("sku") || has("barcode") {
            return ("sku".to_string(), json!({}));
        }
        if has("status") || has("state") {
            return ("orderStatus".to_string(), json!({}));
        }
        if has("description")
            || has("comment")
            || has("note")
            || has("content")
            || has("body")
            || has("bio")
        {
            return (
                "paragraph".to_string(),
                json!({ "maxLength": max_len.min(2000) }),
            );
        }
        if has("title") || has("subject") || has("summary") {
            return ("sentence".to_string(), json!({}));
        }
        if has("product") {
            return ("productName".to_string(), json!({}));
        }
        if has("gender") || has("sex") {
            return ("gender".to_string(), json!({}));
        }
    }

    match family {
        "bool" => return ("bool".to_string(), json!({ "truePercent": 50 })),
        "date" => return ("date".to_string(), json!({})),
        "time" => return ("time".to_string(), json!({})),
        "datetime" => return ("datetime".to_string(), json!({})),
        "year" => return ("year".to_string(), json!({})),
        "json" => return ("json".to_string(), json!({})),
        "uuid" => return ("uuid".to_string(), json!({})),
        "blob" => return ("blob".to_string(), json!({ "length": 16 })),
        "vector" | "sparsevec" => {
            // The declared dimension is part of the type (`vector(1536)`); an unconstrained column
            // accepts any, so pick a small one the user can see in the preview.
            let dims = declared_dims(&col.data_type).unwrap_or(3);
            return if family == "sparsevec" {
                (
                    "vector".to_string(),
                    json!({ "dimensions": dims, "sparse": true, "nonZero": dims.min(10), "normalize": true }),
                )
            } else {
                (
                    "vector".to_string(),
                    json!({ "dimensions": dims, "normalize": true }),
                )
            };
        }
        "text" => {
            return ("paragraph".to_string(), json!({ "maxLength": 500 }));
        }
        "decimal" | "float" => {
            let scale = col.scale.unwrap_or(2).clamp(0, 6);
            let money = has("price")
                || has("amount")
                || has("total")
                || has("cost")
                || has("salary")
                || has("balance")
                || has("fee")
                || has("rate");
            let generator = if family == "float" && !money {
                "float"
            } else {
                "decimal"
            };
            let max = if money { 5_000.0 } else { 1_000.0 };
            return (
                generator.to_string(),
                json!({ "min": 0, "max": max, "scale": scale }),
            );
        }
        "int" | "bigint" => {
            if name.starts_with("is_") || name.starts_with("has_") || name.starts_with("can_") {
                return ("bool".to_string(), json!({ "truePercent": 50 }));
            }
            if has("year") {
                return ("year".to_string(), json!({}));
            }
            if has("age") {
                return ("integer".to_string(), json!({ "min": 18, "max": 80 }));
            }
            if has("quantity") || has("qty") || has("count") || has("stock") {
                return ("integer".to_string(), json!({ "min": 0, "max": 500 }));
            }
            if col.is_pk {
                return ("sequence".to_string(), json!({ "start": 1, "step": 1 }));
            }
            let max = if family == "bigint" {
                1_000_000_000
            } else {
                100_000
            };
            return ("integer".to_string(), json!({ "min": 1, "max": max }));
        }
        _ => {}
    }

    // Fall-through: a plain string sized to the column.
    let max = max_len.clamp(1, 40);
    (
        "string".to_string(),
        json!({ "minLength": (max / 2).max(1), "maxLength": max, "charset": "alnum" }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn col(name: &str, data_type: &str) -> ColMeta {
        ColMeta {
            name: name.into(),
            data_type: data_type.into(),
            nullable: true,
            is_pk: false,
            auto_inc: false,
            has_default: false,
            max_len: None,
            scale: None,
            enum_values: Vec::new(),
        }
    }

    /// A vector column used to fall through to `string` and fail every INSERT with
    /// "invalid input syntax for type vector".
    #[test]
    fn pgvector_columns_get_the_vector_generator_with_their_dimension() {
        let (g, o) = suggest_generator(&col("embedding", "vector(1536)"), None);
        assert_eq!(g, "vector");
        assert_eq!(o["dimensions"], 1536);
        assert!(o.get("sparse").is_none());

        let (g, o) = suggest_generator(&col("h", "ext.halfvec(3)"), None);
        assert_eq!((g.as_str(), o["dimensions"].as_u64()), ("vector", Some(3)));

        let (g, o) = suggest_generator(&col("s", "sparsevec(30000)"), None);
        assert_eq!(g, "vector");
        assert_eq!(
            (o["sparse"].as_bool(), o["nonZero"].as_u64()),
            (Some(true), Some(10))
        );

        // Unconstrained: any dimension is accepted, so a small visible default.
        assert_eq!(
            suggest_generator(&col("e", "vector"), None).1["dimensions"],
            3
        );
    }

    #[test]
    fn look_alike_types_are_not_vectors() {
        assert_eq!(type_family("tsvector"), "string");
        assert_eq!(type_family("int2vector"), "int");
        assert_eq!(declared_dims("numeric(10,2)"), None);
        assert_eq!(declared_dims("vector(8)"), Some(8));
    }
}

# Read and lightly prepare the AI survey responses.
# Run this in RStudio or an R console.

survey_path <- "C:/Users/lengo/Desktop/gopnik-ai/survey_responses_deduped_complete.csv"

if (!file.exists(survey_path)) {
  stop("Could not find the CSV at: ", survey_path)
}

survey_raw <- read.csv(
  survey_path,
  stringsAsFactors = FALSE,
  na.strings = c("", "NA")
)

survey <- survey_raw

# Convert true/false fields.
survey$ai_used <- tolower(survey$ai_used) == "true"
survey$assigned_was_top_choice <- tolower(survey$assigned_was_top_choice) == "true"
survey$low_domain_frequency <- tolower(survey$low_domain_frequency) == "true"

# Convert numeric survey and task variables.
numeric_cols <- c(
  "total_duration_ms",
  "consent_page_duration_ms",
  "first_impressions_duration_ms",
  "what_kind_of_thing_is_ai_duration_ms",
  "how_you_use_ai_duration_ms",
  "ai_use_frequency_duration_ms",
  "your_experience_of_ai_duration_ms",
  "about_you_duration_ms",
  "a_short_task_duration_ms",
  "freq_information_guidance",
  "freq_writing_communication",
  "freq_coding_math_technical",
  "freq_creative_work",
  "freq_learning_understanding",
  "freq_advice_decisions",
  "freq_summarizing_opinions",
  "freq_automation_repetitive",
  "hours_per_week",
  "exp_ai_does_work_vs_user_decides",
  "exp_independent_vs_reliant",
  "exp_existing_info_vs_creating_new",
  "exp_instrument_vs_point_of_view",
  "age",
  "task_selection_top_frequency",
  "self_reported_freq_in_assigned_category",
  "confidence_level",
  "epistemic_ownership",
  "time_before_ai_ms",
  "ai_visible_duration_ms",
  "response_started_ms",
  "response_submitted_ms",
  "task_duration_ms",
  "jaccard_similarity_to_ai"
)

for (col in intersect(numeric_cols, names(survey))) {
  survey[[col]] <- suppressWarnings(as.numeric(survey[[col]]))
}

# Make key categorical variables easier to work with.
survey$ai_kind_choice <- factor(survey$ai_kind_choice)
survey$assigned_category <- factor(survey$assigned_category)
survey$highest_education <- factor(survey$highest_education)
survey$ai_understanding <- factor(survey$ai_understanding)

survey$ai_use_tenure <- factor(
  survey$ai_use_tenure,
  levels = c(
    "I do not use them, or am just starting out.",
    "Less than 6 months",
    "6 to 12 months",
    "1 to 2 years",
    "More than 2 years"
  ),
  ordered = TRUE
)

survey$ai_reading_depth <- factor(
  survey$ai_reading_depth,
  levels = c("not_read", "glanced", "skimmed", "read_carefully"),
  ordered = TRUE
)

# Optional: parse first impression word lists if jsonlite is installed.
if (requireNamespace("jsonlite", quietly = TRUE)) {
  survey$first_impression_words_list <- lapply(
    survey$first_impression_words,
    function(x) {
      if (is.na(x) || !nzchar(x)) return(character())
      tryCatch(jsonlite::fromJSON(x), error = function(e) character())
    }
  )
}

# Basic checks.
cat("Rows:", nrow(survey), "\n")
cat("Columns:", ncol(survey), "\n\n")

cat("AI kind choice:\n")
print(sort(table(survey$ai_kind_choice, useNA = "ifany"), decreasing = TRUE))
cat("\n")

cat("Assigned task category:\n")
print(sort(table(survey$assigned_category, useNA = "ifany"), decreasing = TRUE))
cat("\n")

cat("AI used in task:\n")
print(table(survey$ai_used, useNA = "ifany"))
cat("\n")

cat("AI reading depth:\n")
print(table(survey$ai_reading_depth, useNA = "ifany"))
cat("\n")

cat("Main numeric variables:\n")
print(summary(survey[c(
  "hours_per_week",
  "exp_ai_does_work_vs_user_decides",
  "exp_independent_vs_reliant",
  "exp_existing_info_vs_creating_new",
  "exp_instrument_vs_point_of_view",
  "confidence_level",
  "epistemic_ownership",
  "jaccard_similarity_to_ai"
)]))

# In RStudio, uncomment this line if you want to browse the data.
# View(survey)

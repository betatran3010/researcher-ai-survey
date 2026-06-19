```{r reading-depth-jaccard-density, fig.width=8, fig.height=4.5}
# Distribution of Jaccard similarity: read_carefully vs. everyone else
density_data <- subset(
  reading_depth_data,
  !is.na(jaccard_similarity_to_ai)
)
density_data$reading_group <- factor(
  ifelse(density_data$read_carefully == 1, "Read carefully", "Skimmed / glanced / didn't read"),
  levels = c("Read carefully", "Skimmed / glanced / didn't read")
)

group_means <- aggregate(
  jaccard_similarity_to_ai ~ reading_group,
  data = density_data,
  FUN = mean, na.rm = TRUE
)
group_ns <- table(density_data$reading_group)
group_means$n <- as.integer(group_ns[as.character(group_means$reading_group)])
group_means$label <- sprintf(
  "%s: mean = %.2f (n = %d)",
  group_means$reading_group, group_means$jaccard_similarity_to_ai, group_means$n
)

ggplot(density_data, aes(x = jaccard_similarity_to_ai, fill = reading_group)) +
  geom_density(alpha = 0.45, color = NA, bw = 0.08) +
  geom_vline(
    data = group_means,
    aes(xintercept = jaccard_similarity_to_ai, color = reading_group),
    linetype = "dashed", linewidth = 0.9, show.legend = FALSE
  ) +
  scale_fill_manual(values = c("Read carefully" = "#4472C4",
                               "Skimmed / glanced / didn't read" = "#C00000")) +
  scale_color_manual(values = c("Read carefully" = "#4472C4",
                                "Skimmed / glanced / didn't read" = "#C00000")) +
  scale_x_continuous(limits = c(0, 1), expand = c(0, 0)) +
  labs(
    title    = "Distribution of Similarity to AI by Reading Depth",
    subtitle = paste0(
      group_means$label[group_means$reading_group == "Read carefully"], "  |  ",
      group_means$label[group_means$reading_group == "Skimmed / glanced / didn't read"]
    ),
    x    = "Jaccard Similarity to AI Response",
    y    = "Density",
    fill = NULL
  ) +
  theme_classic(base_size = 12) +
  theme(
    plot.title    = element_text(face = "bold", size = 12),
    plot.subtitle = element_text(size = 9.5),
    legend.position = "bottom"
  )
```

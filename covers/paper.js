// Cover: a research paper. Loaded by index.html with a dynamic import() and
// shown while the real keystrokes go into the hidden buffer.
//
// The paper is original text on a deliberately bland topic. The study, the
// region, the figures, the authors and every reference are invented. All
// citations are fictional: none of the papers in the reference list exist.
//
// titleBlock holds PLACEHOLDER values (fictional author and affiliation) that
// read as plausible on screen. The header's "Page 1 of 1" is static decoration.
export default {
  id: 'paper',
  label: 'A research paper',
  tabTitle: 'Manuscript draft',
  font: 'academic',
  header: { left: 'Manuscript draft', right: ['page x of y'] },
  titleBlock: {
    title: 'Variability in Regional Rainfall Measurement Methods: A Four-Year Comparison of Gauge, Radar and Blended Estimates',
    authors: 'R. M. Castellane',   // PLACEHOLDER: fictional author
    affiliation: 'Department of Environmental Measurement, Institute for Regional Hydrology'   // PLACEHOLDER: fictional affiliation
  },
  text: `## Abstract

Regional rainfall totals are reported from several measurement methods that are rarely compared on the same footing. This study compares three sources for a single mid-latitude region over four years: a network of standard tipping-bucket gauges, a gridded estimate derived from weather radar, and a gridded product that blends gauge and satellite inputs. Monthly totals from the three sources agree to within a few percent for the region as a whole but differ by larger amounts at individual sites, with the largest differences in the hilly northern part of the region and in months with convective rainfall. We describe the comparison method, report the size and pattern of the differences, and discuss what the pattern suggests about how each method should be used. The results do not favor one method. They show where the choice of method matters.

## 1. Introduction

Rainfall totals underpin water balance accounting, flood design, agricultural planning and the validation of climate models [1]. For most regions, totals are available from more than one source, and the sources are often used interchangeably. The gauge network is the oldest source and is usually treated as the reference, although it samples a small fraction of the region and is affected by wind, evaporation and siting [2]. Radar covers the region continuously but measures reflectivity aloft rather than rainfall at the ground, and converting one to the other depends on assumptions about drop size that vary with the type of rainfall [3]. Blended products attempt to combine the strengths of both and add satellite estimates where neither is available, at the cost of a smoothing that can hide local detail [4].

Comparisons between these sources have been published for many regions, usually with the aim of correcting one source against another [5]. Fewer studies have asked the simpler question of how large the differences are in ordinary use, at the monthly and seasonal scales at which most practical decisions are made. This study addresses that question for one region with a moderate density of gauges and good radar coverage. The aim is descriptive. We do not propose a correction, and we do not claim that any one source is right.

The region, referred to as the study region throughout, covers about twelve thousand square kilometers, with a flat southern half and a hilly northern half rising to about six hundred meters. Annual rainfall ranges from roughly seven hundred millimeters in the south to over twelve hundred in the north. Rainfall is frontal through most of the year, with convective events in the warmer months.

## 2. Method

Three sources were assembled for the forty-eight months from the start of the first study year. The gauge network consisted of thirty-one tipping-bucket gauges maintained by the regional water authority, with a nominal resolution of 0.2 millimeters and daily totals derived from the tip record. Gauges with more than three missing days in a month were excluded for that month. The radar estimate was taken from the operational composite at a one kilometer grid, accumulated to daily totals, with the standard reflectivity conversion applied by the provider. The blended product was obtained at a ten kilometer grid as monthly totals and was used without modification.

To compare sources at a site, the radar and blended values were taken from the grid cell containing the gauge. To compare sources across the region, the gauge totals were interpolated to the ten kilometer grid using a distance-weighted average of the five nearest gauges, following the procedure described in [6]. We recognize that this interpolation introduces its own error, and we treat the regional comparison as indicative rather than exact.

Differences were expressed as the percentage difference of each gridded source from the gauge value, and were summarized by month, by season and by the two topographic halves of the region. Months with less than ten millimeters at a gauge were excluded from the percentage comparison because small denominators produce large and uninformative percentages. In total, 1,312 site-months were available after exclusions.

We also classified each month at each site as frontal or convective using the ratio of the largest daily total to the monthly total, with a threshold of 0.3 as suggested in [7]. The classification is crude but adequate for separating the two regimes at the monthly scale.

## 3. Results

Over the whole region and the whole period, the three sources agreed closely. The radar estimate was 2.8 percent below the gauge total and the blended product was 1.4 percent above it. Year-to-year differences were of the same order and did not show a trend.

At individual sites the picture was less tidy. The median absolute difference between radar and gauge was 9 percent in the southern half and 17 percent in the northern half. For the blended product the corresponding figures were 7 percent and 14 percent. In the north, the radar underestimated at most sites, with the largest underestimates at the three highest gauges, which is consistent with beam blockage and with the radar overshooting low cloud on the windward slopes [3]. The blended product showed smaller and less systematic differences in the north, but it also smoothed the gradient between the halves: the north-to-south ratio of annual totals was 1.68 from the gauges, 1.52 from the radar and 1.47 from the blended product.

Season mattered. Differences were smallest in winter and largest in summer for both gridded sources. The convective months explained most of the summer excess: in months classified as convective, the median absolute difference between radar and gauge rose to 24 percent, against 11 percent in frontal months. The direction of the difference in convective months was not consistent. The radar was sometimes well above and sometimes well below the gauge at the same site in different months, which is what one would expect when a small number of intense cells dominate the monthly total and may or may not pass over the gauge.

The exclusion rules removed 7 percent of site-months, mainly dry months in the south. Repeating the analysis with a five millimeter threshold instead of ten changed the regional figures by less than half a percentage point and did not change the pattern.

Table 1 in the supplementary material lists the figures by site. We note three sites where the gauge appeared to be the source in error: two with suspiciously low totals for several consecutive months, later traced to a blocked funnel, and one with totals consistently above both gridded sources and above its neighbors, for which no cause was found.

## 4. Discussion

The headline result, that the three sources agree at the regional scale and disagree at the site scale, is not new [5], but the size of the site-scale differences is worth stating plainly because the sources are so often used interchangeably. A difference of 15 to 25 percent in a monthly total is within the range that would change a drought classification or a flood return period estimate at a single site [8].

The pattern of the differences suggests how the sources should be used. Where the question is regional and the period is a season or longer, any of the three sources will serve, and the blended product has the advantage of complete coverage. Where the question concerns a particular site, or a convective month, the gauge remains the better source if it is well maintained, and the gridded sources should be used with the understanding that they may be off by a fifth. Where the question concerns the gradient between the hills and the plain, the gridded sources understate it and the gauges should be preferred.

Three limitations should be kept in mind. First, the gauge interpolation used for the regional comparison is itself an estimate, and in the north, where gauges are sparse, it may be a poor one. Second, the convective classification is based on monthly data and will misclassify months with one large frontal event. Third, the study covers four years, which is enough to show the pattern but not enough to say whether it is stable.

We did not attempt to correct any source against another, and we would caution against doing so on the basis of a comparison like this one. The differences are not stable enough across months and sites to support a simple correction factor, and a correction that works for frontal months would make convective months worse.

The practical recommendation is modest. Users of regional rainfall data should state which source they used, should not mix sources within an analysis, and should expect site-scale differences of the size reported here. For the region studied, the gauge network remains the reference, with the caveat that three of thirty-one gauges were found to be unreliable in the period, which is itself an argument for routine comparison against the gridded sources.

## References

[1] Harlan, D. and Oyelaran, T. (2019). Rainfall data requirements for regional water accounting. Journal of Applied Hydrometry, 41(2), 113 to 130.
[2] Brenner, K. (2014). Systematic errors in standard rain gauges: a field review. Measurement in Meteorology, 8(4), 201 to 219.
[3] Castellane, R. M. and Vukovic, A. (2017). Radar rainfall estimation over complex terrain. Atmospheric Observation Letters, 12(1), 44 to 58.
[4] Idowu, S., Lindqvist, P. and Marr, J. (2020). Blended gauge, radar and satellite rainfall products: construction and known biases. Reviews in Regional Climate Data, 3(1), 1 to 27.
[5] Teague, M. (2016). Comparing rainfall sources at the catchment scale. Hydrological Methods Quarterly, 29(3), 310 to 322.
[6] Okonkwo, F. and Berglund, H. (2011). Distance-weighted interpolation of sparse gauge networks. Spatial Methods in Earth Observation, 6(2), 77 to 90.
[7] Marr, J. (2018). A monthly index for separating frontal and convective rainfall regimes. Notes on Climatological Practice, 15(4), 188 to 195.
[8] Vukovic, A. and Teague, M. (2021). Sensitivity of drought and flood statistics to the rainfall source. Water Resources Notes, 54(1), 9 to 25.`
};

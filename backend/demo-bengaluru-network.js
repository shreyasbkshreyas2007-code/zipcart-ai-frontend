const areas = [
  { name: "Whitefield", latitude: 12.9698, longitude: 77.7500, hub: "Central" },
  { name: "Marathahalli", latitude: 12.9591, longitude: 77.6974, hub: "Hub" },
  { name: "Brookefield", latitude: 12.9698, longitude: 77.7150, hub: "Hub" },
  { name: "KR Puram", latitude: 13.0072, longitude: 77.6950, hub: "Hub" },
  { name: "Indiranagar", latitude: 12.9784, longitude: 77.6408, hub: "Hub" },
  { name: "Mahadevapura", latitude: 12.9915, longitude: 77.6878, hub: "Hub" },
  { name: "Bellandur", latitude: 12.9304, longitude: 77.6784, hub: "Hub" },
  { name: "HSR Layout", latitude: 12.9121, longitude: 77.6446, hub: "Hub" },
  { name: "Koramangala", latitude: 12.9352, longitude: 77.6245, hub: "Hub" },
  { name: "BTM Layout", latitude: 12.9166, longitude: 77.6101, hub: "Hub" },
  { name: "Electronic City", latitude: 12.8452, longitude: 77.6602, hub: "Hub" },
  { name: "Hebbal", latitude: 13.0358, longitude: 77.5970, hub: "Hub" },
  { name: "Yelahanka", latitude: 13.1007, longitude: 77.5963, hub: "Hub" },
  { name: "Jayanagar", latitude: 12.9250, longitude: 77.5838, hub: "Hub" },
  { name: "Rajajinagar", latitude: 12.9911, longitude: 77.5525, hub: "Hub" },
];

const syntheticSource = "illustrative Bengaluru demo network; not an operational location";

function buildDemoNetwork() {
  return areas.flatMap((area, areaIndex) =>
    [0, 1].map((branch) => {
      const storeId = 1001 + areaIndex * 2 + branch;
      const isRescueTarget = storeId === 1001;
      const isRescueDonor = storeId === 1002;
      const stock = isRescueTarget ? 4 : isRescueDonor ? 50 : 20 + ((storeId * 7) % 31);
      const hourlyDemand = isRescueTarget ? 8 : isRescueDonor ? 3 : 2 + (storeId % 4);
      const truckArrivalHour = isRescueTarget ? 3 : isRescueDonor ? 4 : 4 + (storeId % 3);

      return {
        store: {
          storeId,
          name: isRescueTarget
            ? "Zipcart Whitefield Central"
            : isRescueDonor
              ? "Zipcart Whitefield North Hub"
              : `Zipcart ${area.name} ${branch === 0 ? area.hub : "North Hub"}`,
          address: null,
          locality: area.name,
          city: "Bengaluru",
          state: "Karnataka",
          latitude: Number((area.latitude + branch * 0.004).toFixed(6)),
          longitude: Number((area.longitude + branch * 0.004).toFixed(6)),
          locationSource: syntheticSource,
          storeType: "synthetic demo dark store",
          verificationStatus: "simulated",
        },
        inventory: {
          storeId,
          sku: "D001",
          product: "Cold Drink 750ml",
          category: "beverages",
          stock,
          hourlyDemand,
          safetyStock: isRescueTarget ? 2 : isRescueDonor ? 8 : 6,
          shelfCapacity: isRescueTarget ? 32 : 80,
          truckArrivalHour,
          transferEtaHours: isRescueTarget ? undefined : isRescueDonor ? 0.25 : 1.5,
          transportCapacity: isRescueTarget ? undefined : isRescueDonor ? 25 : 12,
          inventorySource: syntheticSource,
          verificationStatus: "simulated",
        },
      };
    })
  );
}

module.exports = { areas, buildDemoNetwork, syntheticSource };

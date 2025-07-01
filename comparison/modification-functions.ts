import { faker } from "@faker-js/faker";
import { modifications as flightControlModifications } from "./modifications";

// Helper function to apply modifications targeting a specific complexity score
export function applyModificationsForTargetComplexity(
  doc: any,
  targetComplexity: number,
  complexityRange: { label: string; min: number; max: number }
): { appliedModifications: string[]; actualComplexity: number } {
  const modifications = getAllModifications();
  
  // Apply intelligent modification selection based on target complexity
  const selectedModifications = selectModificationsForComplexity(
    modifications,
    targetComplexity,
    complexityRange
  );
  let totalComplexity = 0;
  const appliedModifications: string[] = [];

  for (const modification of selectedModifications) {
    modification.modify(doc);
    totalComplexity += modification.complexity || 1;
    appliedModifications.push(modification.name);
  }

  return { appliedModifications, actualComplexity: totalComplexity };
}

// Intelligent modification selection to hit target complexity ranges
export function selectModificationsForComplexity(
  modifications: any[],
  targetComplexity: number,
  complexityRange: { label: string; min: number; max: number }
): any[] {
  // Sort modifications by complexity for better selection
  const sortedMods = [...modifications].sort(
    (a, b) => a.complexity - b.complexity
  );

  // Categorize modifications
  const lowComplexity = sortedMods.filter((m) => m.complexity <= 10);
  const mediumComplexity = sortedMods.filter(
    (m) => m.complexity > 10 && m.complexity <= 35
  );
  const highComplexity = sortedMods.filter((m) => m.complexity > 35);

  const selectedMods: any[] = [];
  let currentComplexity = 0;

  if (complexityRange.label === "Low") {
    // For low complexity, use 2-8 simple modifications
    const numMods = faker.number.int({ min: 2, max: 8 });
    for (let i = 0; i < numMods && currentComplexity < targetComplexity; i++) {
      const mod = faker.helpers.arrayElement(lowComplexity);
      selectedMods.push(mod);
      currentComplexity += mod.complexity;
    }
  } else if (complexityRange.label === "Medium") {
    // Mix of low and medium complexity modifications
    const numMedium = faker.number.int({ min: 1, max: 3 });
    const numLow = faker.number.int({ min: 3, max: 8 });

    for (
      let i = 0;
      i < numMedium && currentComplexity < targetComplexity - 20;
      i++
    ) {
      const mod = faker.helpers.arrayElement(mediumComplexity);
      selectedMods.push(mod);
      currentComplexity += mod.complexity;
    }

    for (let i = 0; i < numLow && currentComplexity < targetComplexity; i++) {
      const mod = faker.helpers.arrayElement(lowComplexity);
      selectedMods.push(mod);
      currentComplexity += mod.complexity;
    }
  } else if (complexityRange.label === "High") {
    // Mix with some high complexity modifications
    const numHigh = faker.number.int({ min: 1, max: 2 });
    const numMedium = faker.number.int({ min: 2, max: 4 });
    const numLow = faker.number.int({ min: 3, max: 6 });

    for (
      let i = 0;
      i < numHigh && currentComplexity < targetComplexity - 100;
      i++
    ) {
      const mod = faker.helpers.arrayElement(highComplexity);
      selectedMods.push(mod);
      currentComplexity += mod.complexity;
    }

    for (
      let i = 0;
      i < numMedium && currentComplexity < targetComplexity - 50;
      i++
    ) {
      const mod = faker.helpers.arrayElement(mediumComplexity);
      selectedMods.push(mod);
      currentComplexity += mod.complexity;
    }

    for (let i = 0; i < numLow && currentComplexity < targetComplexity; i++) {
      const mod = faker.helpers.arrayElement(lowComplexity);
      selectedMods.push(mod);
      currentComplexity += mod.complexity;
    }
  } else {
    // Very High
    // Many high complexity modifications
    const numHigh = faker.number.int({ min: 3, max: 8 });
    const numMedium = faker.number.int({ min: 5, max: 10 });
    const numLow = faker.number.int({ min: 5, max: 15 });

    for (
      let i = 0;
      i < numHigh && currentComplexity < targetComplexity - 200;
      i++
    ) {
      const mod = faker.helpers.arrayElement(highComplexity);
      selectedMods.push(mod);
      currentComplexity += mod.complexity;
    }

    for (
      let i = 0;
      i < numMedium && currentComplexity < targetComplexity - 100;
      i++
    ) {
      const mod = faker.helpers.arrayElement(mediumComplexity);
      selectedMods.push(mod);
      currentComplexity += mod.complexity;
    }

    for (let i = 0; i < numLow && currentComplexity < targetComplexity; i++) {
      const mod = faker.helpers.arrayElement(lowComplexity);
      selectedMods.push(mod);
      currentComplexity += mod.complexity;
    }
  }

  return selectedMods;
}

function getAllModifications() {
  return [...flightControlModifications];
} 
import unittest
import numpy as np
from runtime import group, split, fit_platt, calibrated, confusion, threshold_for_recall

class CalibrationTests(unittest.TestCase):
    def test_exact_normalized_duplicates_stay_in_one_split(self):
        self.assertEqual(group('Ａ B\u200b'),group('ab'))
        self.assertEqual(split('Ａ B\u200b'),split('ab'))
    def test_binary_and_nonfinite_scanner_scores_are_rejected(self):
        with self.assertRaises(ValueError):fit_platt([0,1,0,1],[0,1,1,0])
        with self.assertRaises(ValueError):fit_platt([0,float('nan'),2,3],[0,1,0,1])
    def test_continuous_calibration_preserves_rank_and_finite_probabilities(self):
        x=np.array([-3.,-2.,-1.,-.4,.2,.8,1.,2.,3.,4.]);y=np.array([0,0,0,1,0,1,0,1,1,1])
        params=fit_platt(x,y);scores=calibrated(x,params)
        self.assertTrue(np.isfinite(scores).all());self.assertTrue(np.all(np.diff(scores)>0))
    def test_threshold_choice_honors_recall_and_exposes_infeasible_targets(self):
        result=threshold_for_recall([0,0,1,1],np.array([.1,.2,.8,.9]))
        self.assertTrue(result['targetMetOnCalibration'])
        self.assertEqual(result['calibrationMetrics']['fn'],0)
        result=threshold_for_recall([0,1,0,1],np.array([.5,.5,.5,.5]))
        self.assertFalse(result['targetMetOnCalibration'])
    def test_undefined_metrics_are_null_not_fabricated_zero(self):
        self.assertIsNone(confusion([1,1],[.1,.9],.5)['fpr'])

if __name__=='__main__':unittest.main()
